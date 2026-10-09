/**
 * Security state shared by the whole deployment, in one Durable Object (so every check is
 * atomic): per-client rate limits and secret lockouts, invite codes, and the account registry.
 * Clients are identified by a hash of their IP address (CF-Connecting-IP); raw IPs are never
 * stored.
 */
import { DurableObject } from 'cloudflare:workers';
import { constantTimeEqual, sha256Base64Url } from '../../src/utils/web-crypto.js';
import type { Env } from './env.js';

export type SecretCheck = 'ok' | 'wrong' | 'locked';
export type SecretName = 'OWNER_PASSWORD' | 'SETUP_TOKEN';

/** Minimum lengths: the setup token is machine-generated, the password typed by a person. */
export const SECRET_MIN_LENGTH: Record<SecretName, number> = {
  OWNER_PASSWORD: 12,
  SETUP_TOKEN: 32,
};

const LOCKOUT = { maxFailures: 5, durationMs: 15 * 60_000 };
const PRUNE_EVERY = 25;

interface Window {
  count: number;
  resetAt: number;
}

export interface AccountEntry {
  key: string;
  createdAt: number;
}

export class Guard extends DurableObject<Env> {
  private calls = 0;

  /**
   * Fixed-window rate limit: true if `client` may make another `bucket` request.
   * Limits are per client, so one abusive client cannot lock others out.
   */
  async allow(bucket: string, client: string, limit: number, windowMs: number): Promise<boolean> {
    await this.maybePrune();
    const key = `rl:${bucket}:${client}`;
    const now = Date.now();
    const w = await this.ctx.storage.get<Window>(key);
    const current = w && w.resetAt > now ? w : { count: 0, resetAt: now + windowMs };
    if (current.count >= limit) return false;
    await this.ctx.storage.put(key, { count: current.count + 1, resetAt: current.resetAt });
    return true;
  }

  /**
   * Constant-time check of a deployment secret, with a lockout per client after repeated
   * failures. A wrong guess from one client never locks the owner out elsewhere.
   */
  async checkSecret(name: SecretName, candidate: string, client: string): Promise<SecretCheck> {
    await this.maybePrune();
    const key = `lock:${name}:${client}`;
    const now = Date.now();
    const state = await this.ctx.storage.get<Window>(key);
    if (state && state.count >= LOCKOUT.maxFailures && state.resetAt > now) return 'locked';
    const expected = this.env[name];
    const matches =
      typeof expected === 'string' &&
      expected.length >= SECRET_MIN_LENGTH[name] &&
      constantTimeEqual(await sha256Base64Url(candidate), await sha256Base64Url(expected));
    if (matches) {
      await this.ctx.storage.delete(key);
      return 'ok';
    }
    const base =
      state && state.resetAt > now ? state : { count: 0, resetAt: now + LOCKOUT.durationMs };
    await this.ctx.storage.put(key, { count: base.count + 1, resetAt: base.resetAt });
    return 'wrong';
  }

  // ---------------------------------------------------------------- invites (atomic)

  async addInvite(hash: string, ttlMs: number): Promise<void> {
    await this.ctx.storage.put(`invite:${hash}`, Date.now() + ttlMs);
  }

  async hasInvite(hash: string): Promise<boolean> {
    const expires = await this.ctx.storage.get<number>(`invite:${hash}`);
    return expires !== undefined && expires > Date.now();
  }

  /** True once per invite: the check and the deletion cannot interleave inside this object. */
  async consumeInvite(hash: string): Promise<number | undefined> {
    const key = `invite:${hash}`;
    const expires = await this.ctx.storage.get<number>(key);
    await this.ctx.storage.delete(key);
    return expires !== undefined && expires > Date.now() ? expires : undefined;
  }

  /** Puts back an invite consumed by an onboarding that then failed. */
  async restoreInvite(hash: string, expires: number): Promise<void> {
    if (expires > Date.now()) await this.ctx.storage.put(`invite:${hash}`, expires);
  }

  // ---------------------------------------------------------------- account registry

  async registerAccount(key: string): Promise<void> {
    const name = `account:${key}`;
    if (!(await this.ctx.storage.get(name))) {
      await this.ctx.storage.put(name, { key, createdAt: Date.now() } satisfies AccountEntry);
    }
  }

  async accounts(): Promise<AccountEntry[]> {
    return [...(await this.ctx.storage.list<AccountEntry>({ prefix: 'account:' })).values()];
  }

  async removeAccount(key: string): Promise<void> {
    await this.ctx.storage.delete(`account:${key}`);
  }

  // ---------------------------------------------------------------- housekeeping

  private async maybePrune(): Promise<void> {
    if (++this.calls % PRUNE_EVERY !== 0) return;
    const now = Date.now();
    for (const prefix of ['rl:', 'lock:']) {
      const entries = await this.ctx.storage.list<Window>({ prefix, limit: 500 });
      const expired = [...entries].filter(([, w]) => w.resetAt <= now).map(([k]) => k);
      if (expired.length > 0) await this.ctx.storage.delete(expired);
    }
    const invites = await this.ctx.storage.list<number>({ prefix: 'invite:', limit: 500 });
    const stale = [...invites].filter(([, e]) => e <= now).map(([k]) => k);
    if (stale.length > 0) await this.ctx.storage.delete(stale);
  }
}

/** Opaque per-client key: SHA-256 of the connecting IP (never stored in clear). */
export async function clientKey(request: Request): Promise<string> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  return (await sha256Base64Url(`client:${ip}`)).slice(0, 22);
}

export const guard = (env: Env) => env.GUARD.get(env.GUARD.idFromName('guard'));
