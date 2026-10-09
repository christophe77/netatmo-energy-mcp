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
import { constantTimeEqual, randomToken } from '../../src/utils/web-crypto.js';
import { confirmMode, writeLimits, type Env } from './env.js';
import { netatmoFetch } from './netatmo-fetch.js';
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
  /** Netatmo refused the refresh token (revoked or expired). Kept so setup can be redone. */
  revoked?: boolean;
}

export interface AccountStatus {
  linked: boolean;
  revoked?: boolean;
  scopes: string[];
  writeMode: boolean;
  linkedAt?: string;
  tokenExpiresAt?: string;
}

const LINK_KEY = 'netatmo-link';
const REFRESH_MARGIN_MS = 5 * 60_000;
const AUDIT_RETENTION_MS = 90 * 86_400_000;

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
    let auth: AuthFacts;
    try {
      auth = JSON.parse(request.headers.get(AUTH_HEADER) ?? '') as AuthFacts;
    } catch {
      return new Response('Forbidden', { status: 403 });
    }
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

  /**
   * One refresh at a time: Netatmo may invalidate the previous refresh token immediately.
   * The result is only saved if the link was not replaced meanwhile (e.g. by setup).
   */
  private refresh(link: StoredLink): Promise<TokenSet> {
    this.refreshing ??= (async () => {
      const used = link.tokens.refreshToken;
      try {
        const { tokens } = await refreshAccessToken(
          {
            clientId: link.clientId,
            clientSecret: link.clientSecret,
            refreshToken: used,
            now: Date.now(),
          },
          { fetch: this.fetchFn },
        );
        // OAuth 2.0: a refresh response without `scope` keeps the scope originally granted.
        const next = tokens.scope.length > 0 ? tokens : { ...tokens, scope: link.tokens.scope };
        const current = await this.loadLink();
        if (!current || current.tokens.refreshToken !== used) {
          // Replaced while refreshing (setup): keep the new link and use its tokens.
          return (await this.requireLink()).tokens;
        }
        await this.saveLink({ ...current, tokens: next });
        return next;
      } catch (error) {
        if (error instanceof InvalidGrantError) {
          const current = await this.loadLink();
          // Only the link whose token was refused is marked; a newer link is left alone.
          if (current && current.tokens.refreshToken === used) {
            await this.saveLink({ ...current, revoked: true });
            this.handler = undefined;
          }
          throw revokedError();
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
    if (link.revoked) throw revokedError();
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

  // ---------------------------------------------------------------- RPC (Worker only)

  /** Link (or re-link) this account to a Netatmo app and tokens, then check they work. */
  async setup(input: NetatmoLink): Promise<AccountStatus & { homes: number }> {
    const link = validateLink(input);
    // Let an in-flight refresh of the old link finish first; it will not overwrite the new one.
    await this.refreshing?.catch(() => undefined);
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
      // Keep the previous link rather than a broken one.
      if (previous) {
        await this.saveLink(previous);
      } else {
        await this.ctx.storage.delete(LINK_KEY);
        this.link = null;
      }
      this.handler = undefined;
      throw error;
    }
  }

  async status(): Promise<AccountStatus> {
    const link = await this.loadLink();
    if (!link) return { linked: false, scopes: [], writeMode: false };
    return {
      linked: true,
      ...(link.revoked && { revoked: true }),
      scopes: link.tokens.scope,
      writeMode: this.env.NETATMO_MCP_WRITE !== '0' && link.tokens.scope.includes(WRITE_SCOPE),
      linkedAt: new Date(link.linkedAt).toISOString(),
      tokenExpiresAt: new Date(link.tokens.expiresAt).toISOString(),
    };
  }

  /** Deletes everything this account stored: Netatmo link, confirmations, change log. */
  async erase(): Promise<void> {
    await this.refreshing?.catch(() => undefined);
    await this.ctx.storage.deleteAll();
    this.link = null;
    this.handler = undefined;
  }
}

function revokedError(): AuthRequiredError {
  return new AuthRequiredError(
    'Netatmo no longer accepts the stored authorization (revoked or expired).',
    {
      hint: 'Run "netatmo-energy-mcp remote setup <url>" again (owner), or reconnect the connector (onboarded account).',
    },
  );
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
