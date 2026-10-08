import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore, type TokenSet } from '../../../src/auth/credential-store.js';
import { resolveClientCredentials, TokenManager } from '../../../src/auth/token-manager.js';
import { configPaths } from '../../../src/config/paths.js';
import { AuthRequiredError } from '../../../src/errors.js';
import { silentLogger } from '../../../src/utils/logger.js';
import { fakeFetch, json, tokenResponse } from '../../helpers/fake-fetch.js';

const HOUR = 3_600_000;
let dir: string;
let now: number;
const clock = { now: () => now, sleep: async () => {} };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'nem-tm-'));
  now = 1_700_000_000_000;
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function tokens(n: number, expiresAt: number, clientId = 'cid'): TokenSet {
  return {
    accessToken: `access-${n}`,
    refreshToken: `refresh-${n}`,
    expiresAt,
    obtainedAt: expiresAt - 3 * HOUR,
    scope: ['read_thermostat'],
    clientId,
  };
}

async function seed(t: TokenSet) {
  const store = new CredentialStore(configPaths(dir), silentLogger, clock);
  await store.update(() => ({ version: 1, clientId: 'cid', clientSecret: 'sec', tokens: t }));
  return store;
}

function manager(store: CredentialStore, fetchFn: typeof fetch, envClient = {}) {
  return new TokenManager({ store, envClient, logger: silentLogger, clock, fetch: fetchFn });
}

describe('TokenManager', () => {
  it('returns a still-valid stored token without calling Netatmo', async () => {
    const store = await seed(tokens(1, now + 2 * HOUR));
    const f = fakeFetch(() => json(tokenResponse(2)));
    const tm = manager(store, f);
    expect(await tm.getAccessToken()).toBe('access-1');
    expect(await tm.getAccessToken()).toBe('access-1');
    expect(f.requests).toHaveLength(0);
  });

  it('refreshes near expiry and persists the rotated refresh token immediately', async () => {
    const store = await seed(tokens(1, now + 60_000)); // inside the 5 min margin
    const f = fakeFetch(() => json(tokenResponse(2)));
    const tm = manager(store, f);
    expect(await tm.getAccessToken()).toBe('access-2');
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.form.get('refresh_token')).toBe('refresh-1');
    const saved = await store.read();
    expect(saved?.tokens?.refreshToken).toBe('refresh-2');
    expect(saved?.tokens?.expiresAt).toBe(now + 10_800_000);
    expect(saved?.clientSecret).toBe('sec');
  });

  it('single-flights concurrent refreshes within a process', async () => {
    const store = await seed(tokens(1, now - 1));
    const f = fakeFetch(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return json(tokenResponse(2));
    });
    const tm = manager(store, f);
    const results = await Promise.all([
      tm.getAccessToken(),
      tm.getAccessToken(),
      tm.getAccessToken(),
    ]);
    expect(results).toEqual(['access-2', 'access-2', 'access-2']);
    expect(f.requests).toHaveLength(1);
  });

  it('serializes refreshes across processes so only one rotation happens', async () => {
    const storeA = await seed(tokens(1, now - 1));
    const storeB = new CredentialStore(configPaths(dir), silentLogger, clock);
    let issued = 1;
    const valid = new Set(['refresh-1']);
    // A Netatmo stand-in that invalidates refresh tokens on use, like the real API.
    const netatmo = async (req: { form: URLSearchParams }) => {
      await new Promise((r) => setTimeout(r, 15));
      const rt = req.form.get('refresh_token') ?? '';
      if (!valid.delete(rt)) return json({ error: 'invalid_grant' }, 400);
      issued += 1;
      valid.add(`refresh-${issued}`);
      return json(tokenResponse(issued));
    };
    const fA = fakeFetch(netatmo);
    const fB = fakeFetch(netatmo);
    const realClock = {
      now: () => now,
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    };
    const a = new TokenManager({
      store: storeA,
      envClient: {},
      logger: silentLogger,
      clock: realClock,
      fetch: fA,
    });
    const b = new TokenManager({
      store: storeB,
      envClient: {},
      logger: silentLogger,
      clock: realClock,
      fetch: fB,
    });
    const [ta, tb] = await Promise.all([a.getAccessToken(), b.getAccessToken()]);
    expect(ta).toBe('access-2');
    expect(tb).toBe('access-2');
    expect(fA.requests.length + fB.requests.length).toBe(1);
    expect((await storeA.read())?.tokens?.refreshToken).toBe('refresh-2');
  });

  it('adopts tokens rotated by another process after losing a race (invalid_grant)', async () => {
    const store = await seed(tokens(1, now - 1));
    const f = fakeFetch(async () => {
      // Another process rotates the token and writes the file while we are refreshing.
      const raw = JSON.parse(await fs.readFile(store.paths.credentials, 'utf8')) as object;
      await fs.writeFile(
        store.paths.credentials,
        JSON.stringify({ ...raw, tokens: tokens(7, now + 3 * HOUR) }),
      );
      return json({ error: 'invalid_grant' }, 400);
    });
    const tm = manager(store, f);
    expect(await tm.getAccessToken()).toBe('access-7');
  });

  it('asks for login when the refresh token is revoked', async () => {
    const store = await seed(tokens(1, now - 1));
    const tm = manager(
      store,
      fakeFetch(() => json({ error: 'invalid_grant' }, 400)),
    );
    await expect(tm.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
    // Tokens are never deleted automatically.
    expect((await store.read())?.tokens?.refreshToken).toBe('refresh-1');
  });

  it('forces a refresh when the API rejects a token that looked valid', async () => {
    const store = await seed(tokens(1, now + 2 * HOUR));
    const f = fakeFetch(() => json(tokenResponse(2)));
    const tm = manager(store, f);
    expect(await tm.getAccessToken()).toBe('access-1');
    expect(await tm.handleRejectedToken('access-1')).toBe('access-2');
    expect(f.requests).toHaveLength(1);
  });

  it('does not refresh again if the rejected token was already replaced by another process', async () => {
    const store = await seed(tokens(2, now + 2 * HOUR));
    const f = fakeFetch(() => json(tokenResponse(3)));
    const tm = manager(store, f);
    expect(await tm.handleRejectedToken('access-1')).toBe('access-2');
    expect(f.requests).toHaveLength(0);
  });

  it('requires login when nothing is stored or the app changed', async () => {
    const empty = new CredentialStore(configPaths(dir), silentLogger, clock);
    await expect(manager(empty, fakeFetch()).getAccessToken()).rejects.toThrow(/credentials/);

    const store = await seed(tokens(1, now - 1));
    const tm = manager(store, fakeFetch(), { clientId: 'other-app', clientSecret: 'x' });
    await expect(tm.getAccessToken()).rejects.toThrow(/different Netatmo app/);
  });

  it('uses environment credentials in preference to stored ones', async () => {
    const store = await seed(tokens(1, now - 1));
    const f = fakeFetch(() => json(tokenResponse(2)));
    await manager(store, f, { clientId: 'cid', clientSecret: 'env-secret' }).getAccessToken();
    expect(f.requests[0]!.form.get('client_secret')).toBe('env-secret');
  });

  it('keeps rotated tokens in memory when saving fails, then saves them later', async () => {
    const store = await seed(tokens(1, now - 1));
    const write = vi.spyOn(store, 'writeUnlocked').mockRejectedValueOnce(new Error('disk full'));
    const f = fakeFetch(() => json(tokenResponse(2)));
    const tm = manager(store, f);
    expect(await tm.getAccessToken()).toBe('access-2');
    expect((await store.read())?.tokens?.refreshToken).toBe('refresh-1');
    expect(await tm.getAccessToken()).toBe('access-2');
    expect(write).toHaveBeenCalledTimes(2);
    expect((await store.read())?.tokens?.refreshToken).toBe('refresh-2');
    expect(f.requests).toHaveLength(1);
  });
});

describe('resolveClientCredentials', () => {
  const stored = { version: 1 as const, clientId: 'stored-id', clientSecret: 'stored-secret' };

  it('prefers environment values', () => {
    expect(resolveClientCredentials({ clientId: 'e', clientSecret: 's' }, stored)).toEqual({
      clientId: 'e',
      clientSecret: 's',
      source: 'env',
    });
  });

  it('never pairs a stored secret with a different env client id', () => {
    expect(resolveClientCredentials({ clientId: 'e' }, stored)).toBeUndefined();
  });

  it('falls back to stored values', () => {
    expect(resolveClientCredentials({}, stored)?.source).toBe('stored');
    expect(resolveClientCredentials({ clientSecret: 'x' }, stored)?.source).toBe('mixed');
  });
});
