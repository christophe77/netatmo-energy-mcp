/**
 * One Netatmo account (ADR-0014 §4). Its Durable Object serves that account's MCP requests, so
 * one Netatmo client per account lives here with its cache and rate limiter, token refreshes are
 * serialized (Netatmo rotates refresh tokens), and confirmations and the change log are durable.
 */
import { DurableObject } from 'cloudflare:workers';
import { InvalidGrantError, refreshAccessToken, type FetchFn } from '../../src/auth/oauth.js';
import type { TokenProvider, TokenSet } from '../../src/auth/token-set.js';
import type { AuditEntry, AuditLog } from '../../src/domain/audit-log.js';
import { createServices } from '../../src/domain/services.js';
import { AuthRequiredError, InvalidArgumentError } from '../../src/errors.js';
import { CONFIRMATION_TTL_MS, type ConfirmationStore } from '../../src/mcp/confirm.js';
import { CfWorkerJsonSchemaValidator, createMcpHandler } from '../../src/mcp/http.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { NetatmoClient } from '../../src/netatmo/client.js';
import { RateLimiter } from '../../src/netatmo/rate-limiter.js';
import { WRITE_SCOPE } from '../../src/netatmo/write-endpoints.js';
import { systemClock } from '../../src/utils/clock.js';
import { createLogger, type Logger, type LogLevel } from '../../src/utils/logger.js';
import { constantTimeEqual, randomToken, sha256Base64Url } from '../../src/utils/web-crypto.js';
import { confirmMode, writeLimits, type Env } from './env.js';
import { importDataKey, seal, unseal } from './seal.js';

/** Header carrying the verified MCP token facts from the Worker to the account object. */
export const AUTH_HEADER = 'x-netatmo-mcp-auth';

export interface AuthFacts {
  clientId: string;
  scopes: string[];
  expiresAt?: number;
}

/** Netatmo app credentials and tokens for one account. Stored only sealed. */
export interface NetatmoLink {
  clientId: string;
  clientSecret: string;
  tokens: TokenSet;
}

interface StoredLink extends NetatmoLink {
  linkedAt: number;
}

export interface AccountStatus {
  linked: boolean;
  scopes: string[];
  writeMode: boolean;
  linkedAt?: string;
  tokenExpiresAt?: string;
}

export type SecretCheck = 'ok' | 'wrong' | 'locked';

const LINK_KEY = 'netatmo-link';
const REFRESH_MARGIN_MS = 5 * 60_000;
const AUDIT_RETENTION_MS = 90 * 86_400_000;
const LOCKOUT = { maxFailures: 5, durationMs: 15 * 60_000 };

export class Account extends DurableObject<Env> {
  private dataKey?: Promise<CryptoKey>;
  private link?: StoredLink | null;
  private refreshing?: Promise<TokenSet> | undefined;
  private handler?: ReturnType<typeof createMcpHandler> | undefined;
  private readonly logger: Logger;
  private readonly fetchFn: FetchFn;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.logger = createLogger({ level: (env.LOG_LEVEL as LogLevel | undefined) ?? 'info' });
    this.fetchFn = netatmoFetch(env.NETATMO_API_BASE);
  }

  // ---------------------------------------------------------------- MCP endpoint

  override async fetch(request: Request): Promise<Response> {
    const raw = request.headers.get(AUTH_HEADER);
    if (!raw) return new Response('Forbidden', { status: 403 });
    const auth = JSON.parse(raw) as AuthFacts;
    const headers = new Headers(request.headers);
    headers.delete(AUTH_HEADER);
    const handler = await this.mcpHandler();
    return handler.fetch(new Request(request, { headers }), {
      authInfo: {
        token: '',
        clientId: auth.clientId,
        scopes: auth.scopes,
        ...(auth.expiresAt !== undefined && { expiresAt: auth.expiresAt }),
      },
    });
  }

  private async mcpHandler(): Promise<ReturnType<typeof createMcpHandler>> {
    if (this.handler) return this.handler;
    const link = await this.loadLink();
    const writeMode =
      this.env.NETATMO_MCP_WRITE !== '0' && (link?.tokens.scope.includes(WRITE_SCOPE) ?? false);
    const client = new NetatmoClient({
      tokens: this.tokenProvider,
      logger: this.logger,
      clock: systemClock,
      allowWrites: writeMode,
      rateLimiter: new RateLimiter({ clock: systemClock }),
      fetch: this.fetchFn,
    });
    const { service, analytics, control } = createServices(
      client,
      systemClock,
      writeLimits(this.env),
      new DurableAuditLog(this.ctx.storage, this.logger),
    );
    const confirmations = new DurableConfirmations(this.ctx.storage);
    const mode = confirmMode(this.env);
    this.handler = createMcpHandler(
      () =>
        createMcpServer(service, analytics, this.logger, {
          control,
          writeMode,
          confirmMode: mode,
          confirmations,
          jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
        }),
      { onerror: (error) => this.logger.warn('MCP request error', { error: error.message }) },
    );
    return this.handler;
  }

  // ---------------------------------------------------------------- Netatmo tokens

  private readonly tokenProvider: TokenProvider = {
    getAccessToken: async () => {
      const link = await this.requireLink();
      if (link.tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) return link.tokens.accessToken;
      return (await this.refresh(link)).accessToken;
    },
    handleRejectedToken: async (rejected) => {
      const link = await this.requireLink();
      if (!constantTimeEqual(link.tokens.accessToken, rejected)) return link.tokens.accessToken;
      return (await this.refresh(link)).accessToken;
    },
  };

  /** One refresh at a time: Netatmo may invalidate the previous refresh token immediately. */
  private refresh(link: StoredLink): Promise<TokenSet> {
    this.refreshing ??= (async () => {
      try {
        const { tokens } = await refreshAccessToken(
          {
            clientId: link.clientId,
            clientSecret: link.clientSecret,
            refreshToken: link.tokens.refreshToken,
            now: Date.now(),
          },
          { fetch: this.fetchFn },
        );
        // OAuth 2.0: a refresh response without `scope` keeps the scope originally granted.
        const next = tokens.scope.length > 0 ? tokens : { ...tokens, scope: link.tokens.scope };
        await this.saveLink({ ...link, tokens: next });
        return next;
      } catch (error) {
        if (error instanceof InvalidGrantError) {
          await this.unlink();
          throw new AuthRequiredError(
            'Netatmo no longer accepts the stored authorization (revoked or expired).',
            { hint: 'The owner runs "netatmo-energy-mcp remote setup <url>" again.' },
          );
        }
        throw error;
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  private async requireLink(): Promise<StoredLink> {
    const link = await this.loadLink();
    if (!link) {
      throw new AuthRequiredError('This server is not linked to a Netatmo account yet.', {
        hint: 'The owner runs "netatmo-energy-mcp remote setup <url>".',
      });
    }
    return link;
  }

  private key(): Promise<CryptoKey> {
    this.dataKey ??= importDataKey(this.env.DATA_KEY);
    return this.dataKey;
  }

  /** Sealed records are bound to this object's ID, so they cannot be moved to another account. */
  private get binding(): string {
    return `account:${this.ctx.id.toString()}`;
  }

  private async loadLink(): Promise<StoredLink | null> {
    if (this.link !== undefined) return this.link;
    const sealed = await this.ctx.storage.get<string>(LINK_KEY);
    this.link = sealed ? await unseal<StoredLink>(await this.key(), sealed, this.binding) : null;
    return this.link;
  }

  private async saveLink(link: StoredLink): Promise<void> {
    await this.ctx.storage.put(LINK_KEY, await seal(await this.key(), link, this.binding));
    this.link = link;
  }

  private async unlink(): Promise<void> {
    await this.ctx.storage.delete(LINK_KEY);
    this.link = null;
    this.handler = undefined;
  }

  // ---------------------------------------------------------------- RPC (Worker only)

  /** Link (or re-link) this account to a Netatmo app and tokens, then check they work. */
  async setup(input: NetatmoLink): Promise<AccountStatus & { homes: number }> {
    const link = validateLink(input);
    const previous = await this.loadLink();
    await this.saveLink({ ...link, linkedAt: Date.now() });
    this.handler = undefined;
    try {
      const client = new NetatmoClient({
        tokens: this.tokenProvider,
        logger: this.logger,
        fetch: this.fetchFn,
      });
      const { body } = await client.homesData();
      return { ...(await this.status()), homes: body.homes?.length ?? 0 };
    } catch (error) {
      // Keep the previous working link rather than a broken one.
      if (previous) await this.saveLink(previous);
      else await this.unlink();
      this.handler = undefined;
      throw error;
    }
  }

  async status(): Promise<AccountStatus> {
    const link = await this.loadLink();
    if (!link) return { linked: false, scopes: [], writeMode: false };
    return {
      linked: true,
      scopes: link.tokens.scope,
      writeMode: this.env.NETATMO_MCP_WRITE !== '0' && link.tokens.scope.includes(WRITE_SCOPE),
      linkedAt: new Date(link.linkedAt).toISOString(),
      tokenExpiresAt: new Date(link.tokens.expiresAt).toISOString(),
    };
  }

  /**
   * Constant-time check of a secret (owner password or setup token), with a lockout after
   * repeated failures so it cannot be brute-forced. `name` selects the secret.
   */
  async checkSecret(
    name: 'OWNER_PASSWORD' | 'SETUP_TOKEN',
    candidate: string,
  ): Promise<SecretCheck> {
    const stateKey = `lockout:${name}`;
    const now = Date.now();
    const state = (await this.ctx.storage.get<{ failures: number; until: number }>(stateKey)) ?? {
      failures: 0,
      until: 0,
    };
    if (state.until > now) return 'locked';
    const expected = this.env[name];
    // Hash both sides so the comparison is constant-time whatever the lengths.
    const matches =
      typeof expected === 'string' &&
      expected.length >= 12 &&
      constantTimeEqual(await sha256Base64Url(candidate), await sha256Base64Url(expected));
    if (matches) {
      await this.ctx.storage.delete(stateKey);
      return 'ok';
    }
    const failures = state.failures + 1;
    await this.ctx.storage.put(
      stateKey,
      failures >= LOCKOUT.maxFailures
        ? { failures: 0, until: now + LOCKOUT.durationMs }
        : { failures, until: 0 },
    );
    return 'wrong';
  }
}

// ------------------------------------------------------------------ helpers

function validateLink(input: NetatmoLink): NetatmoLink {
  const t = input?.tokens;
  const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  if (
    !nonEmpty(input?.clientId) ||
    !nonEmpty(input.clientSecret) ||
    !nonEmpty(t?.accessToken) ||
    !nonEmpty(t.refreshToken) ||
    typeof t.expiresAt !== 'number' ||
    !Array.isArray(t.scope)
  ) {
    throw new InvalidArgumentError('Incomplete Netatmo credentials.');
  }
  return {
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    tokens: {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      expiresAt: t.expiresAt,
      obtainedAt: typeof t.obtainedAt === 'number' ? t.obtainedAt : Date.now(),
      scope: t.scope.filter((s): s is string => typeof s === 'string'),
      clientId: input.clientId,
    },
  };
}

/**
 * `fetch` for Netatmo. NETATMO_API_BASE redirects api.netatmo.com to a local fake for tests; it
 * is honoured only for loopback addresses, so a misconfiguration cannot send tokens elsewhere.
 */
function netatmoFetch(base: string | undefined): FetchFn {
  if (!base) return (input, init) => fetch(input, init);
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
    throw new Error('NETATMO_API_BASE may only point to a loopback address (tests).');
  }
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return fetch(url.replace(/^https:\/\/api\.netatmo\.com/, base), init);
  };
}

/** Confirmation tokens in Durable Object storage: shared by every request of the account. */
class DurableConfirmations implements ConfirmationStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  now(): number {
    return Date.now();
  }

  async issue(key: string, issuedAt: number = Date.now()): Promise<string> {
    await this.prune();
    const token = randomToken(18);
    await this.storage.put(`confirm:${token}`, {
      key,
      issuedAt,
      expires: Date.now() + CONFIRMATION_TTL_MS,
    });
    return token;
  }

  async issuedAt(token: string): Promise<number | undefined> {
    const entry = await this.storage.get<{ issuedAt: number; expires: number }>(`confirm:${token}`);
    return entry && entry.expires > Date.now() ? entry.issuedAt : undefined;
  }

  async consume(token: string, key: string): Promise<boolean> {
    const name = `confirm:${token}`;
    const entry = await this.storage.get<{ key: string; expires: number }>(name);
    await this.storage.delete(name);
    return entry !== undefined && entry.key === key && entry.expires > Date.now();
  }

  private async prune(): Promise<void> {
    const now = Date.now();
    const entries = await this.storage.list<{ expires: number }>({
      prefix: 'confirm:',
      limit: 200,
    });
    const expired = [...entries].filter(([, e]) => e.expires <= now).map(([k]) => k);
    if (expired.length > 0) await this.storage.delete(expired);
  }
}

/** Change log in Durable Object storage, kept for 90 days. */
class DurableAuditLog implements AuditLog {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly logger: Logger,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.storage.put(`audit:${entry.time}:${randomToken(6)}`, entry);
      const cutoff = new Date(Date.now() - AUDIT_RETENTION_MS).toISOString();
      const old = await this.storage.list({ prefix: 'audit:', end: `audit:${cutoff}`, limit: 100 });
      if (old.size > 0) await this.storage.delete([...old.keys()]);
    } catch (error) {
      this.logger.warn('Could not write the change log', { error });
    }
  }
}
