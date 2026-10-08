import { AuthRequiredError } from '../errors.js';
import { systemClock, type Clock } from '../utils/clock.js';
import type { Logger } from '../utils/logger.js';
import type { CredentialStore, StoredCredentials, TokenSet } from './credential-store.js';
import { InvalidGrantError, refreshAccessToken, type FetchFn } from './oauth.js';

/** What the Netatmo API client needs from authentication. */
export interface TokenProvider {
  /** A currently valid access token, refreshing first if needed. */
  getAccessToken(signal?: AbortSignal): Promise<string>;
  /**
   * Called when the API rejected `rejectedToken` as invalid or expired.
   * Returns a different, fresh token, or throws AuthRequiredError.
   */
  handleRejectedToken(rejectedToken: string, signal?: AbortSignal): Promise<string>;
}

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
  source: 'env' | 'stored' | 'mixed';
}

/**
 * Environment variables take precedence over stored values (approved decision, Phase 0 review).
 */
export function resolveClientCredentials(
  env: { clientId?: string; clientSecret?: string },
  stored: StoredCredentials | undefined,
): ClientCredentials | undefined {
  const clientId = env.clientId ?? stored?.clientId;
  // A stored secret only belongs to the stored client id.
  const storedSecret =
    stored?.clientSecret && stored.clientId === clientId ? stored.clientSecret : undefined;
  const clientSecret = env.clientSecret ?? storedSecret;
  if (!clientId || !clientSecret) return undefined;
  const fromEnv = [env.clientId !== undefined, env.clientSecret !== undefined];
  const source = fromEnv.every(Boolean) ? 'env' : fromEnv.some(Boolean) ? 'mixed' : 'stored';
  return { clientId, clientSecret, source };
}

export interface TokenManagerOptions {
  store: CredentialStore;
  envClient: { clientId?: string; clientSecret?: string };
  logger: Logger;
  clock?: Clock;
  fetch?: FetchFn;
  /** Refresh this long before the access token expires. */
  refreshMarginMs?: number;
}

/**
 * Supplies access tokens and refreshes them safely (ADR-0005):
 * - single-flight within the process,
 * - serialized across processes by the credentials lock,
 * - re-reads the file under the lock so a token already rotated by another process is adopted,
 * - recovers from a lost refresh race (invalid_grant while the file holds a newer token),
 * - persists a new token pair immediately after receiving it.
 */
export class TokenManager implements TokenProvider {
  private readonly clock: Clock;
  private readonly refreshMarginMs: number;
  private current: TokenSet | undefined;
  private inflight: Promise<TokenSet> | undefined;
  /** A rotated pair that could not be written to disk yet. */
  private unpersisted: StoredCredentials | undefined;

  constructor(private readonly opts: TokenManagerOptions) {
    this.clock = opts.clock ?? systemClock;
    this.refreshMarginMs = opts.refreshMarginMs ?? 5 * 60_000;
  }

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    await this.retryPersist();
    if (this.current && this.isFresh(this.current)) return this.current.accessToken;
    const tokens = await this.refresh(undefined, signal);
    return tokens.accessToken;
  }

  async handleRejectedToken(rejectedToken: string, signal?: AbortSignal): Promise<string> {
    const tokens = await this.refresh(rejectedToken, signal);
    if (tokens.accessToken === rejectedToken) {
      throw new AuthRequiredError(
        'Netatmo rejected the access token, and refreshing did not help.',
      );
    }
    return tokens.accessToken;
  }

  private isFresh(tokens: TokenSet): boolean {
    return tokens.expiresAt - this.refreshMarginMs > this.clock.now();
  }

  private refresh(rejectedToken: string | undefined, signal?: AbortSignal): Promise<TokenSet> {
    this.inflight ??= this.refreshUnderLock(rejectedToken, signal).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async refreshUnderLock(
    rejectedToken: string | undefined,
    signal?: AbortSignal,
  ): Promise<TokenSet> {
    const { store } = this.opts;
    return store.withLock(async () => {
      const stored = this.unpersisted ?? (await store.read());
      const client = resolveClientCredentials(this.opts.envClient, stored);
      if (!client) {
        throw new AuthRequiredError(
          'No Netatmo app credentials found (client ID and client secret).',
        );
      }
      const tokens = stored?.tokens;
      if (!tokens) {
        throw new AuthRequiredError('Not logged in to Netatmo.');
      }
      if (tokens.clientId !== client.clientId) {
        throw new AuthRequiredError(
          'The stored tokens were issued to a different Netatmo app than the configured client ID.',
        );
      }

      // Another process (or an earlier call) may already have rotated the token.
      if (this.isFresh(tokens) && tokens.accessToken !== rejectedToken) {
        this.current = tokens;
        return tokens;
      }

      let next: TokenSet;
      try {
        const res = await refreshAccessToken(
          {
            clientId: client.clientId,
            clientSecret: client.clientSecret,
            refreshToken: tokens.refreshToken,
            now: this.clock.now(),
          },
          { ...(this.opts.fetch && { fetch: this.opts.fetch }), ...(signal && { signal }) },
        );
        next = res.tokens;
      } catch (error) {
        if (error instanceof InvalidGrantError) {
          // Lost a race with a writer that did not hold the lock (e.g. a concurrent login)?
          const latest = await store.read().catch(() => undefined);
          if (latest?.tokens && latest.tokens.refreshToken !== tokens.refreshToken) {
            this.opts.logger.info('Adopted tokens refreshed by another process');
            this.current = latest.tokens;
            return latest.tokens;
          }
          throw new AuthRequiredError(
            'Netatmo rejected the stored refresh token (expired, revoked or already used).',
            { cause: error },
          );
        }
        throw error;
      }

      // Persist immediately: the previous refresh token is now invalid on Netatmo's side.
      const updated: StoredCredentials = {
        ...stored,
        version: 1,
        tokens: next,
      };
      this.current = next;
      try {
        await store.writeUnlocked(updated);
        this.unpersisted = undefined;
      } catch (error) {
        this.unpersisted = updated;
        this.opts.logger.error(
          'Could not save refreshed tokens; keeping them in memory and retrying later',
          { error },
        );
      }
      this.opts.logger.debug('Access token refreshed', {
        expiresInS: Math.round((next.expiresAt - this.clock.now()) / 1000),
      });
      return next;
    });
  }

  private async retryPersist(): Promise<void> {
    const pending = this.unpersisted;
    if (!pending) return;
    try {
      await this.opts.store.withLock(() => this.opts.store.writeUnlocked(pending));
      this.unpersisted = undefined;
      this.opts.logger.info('Saved previously unsaved refreshed tokens');
    } catch {
      // Still failing; keep serving from memory.
    }
  }
}
