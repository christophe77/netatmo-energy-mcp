/** Regression tests for the Phase 6 security review findings. */
import fs from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startCallbackServer } from '../../src/auth/callback-server.js';
import { CredentialStore } from '../../src/auth/credential-store.js';
import { acquireFileLock } from '../../src/auth/lock.js';
import { OAuthError, parseRedirectUrl } from '../../src/auth/oauth.js';
import { containsOnlyOwnFiles, ensureSecureDir } from '../../src/auth/secure-fs.js';
import { TokenManager } from '../../src/auth/token-manager.js';
import { browserCommand } from '../../src/cli/browser.js';
import { configPaths } from '../../src/config/paths.js';
import { Sanitizer } from '../../src/probe/sanitize.js';
import { redact, redactText, REDACTED, silentLogger, type Logger } from '../../src/utils/logger.js';
import { fakeFetch, json, tokenResponse } from '../helpers/fake-fetch.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'nem-sec-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('M1: a cancelled caller never aborts a token refresh', () => {
  it('finishes and saves the refresh even if the waiting tool call is cancelled', async () => {
    const store = new CredentialStore(configPaths(dir), silentLogger);
    await store.update(() => ({
      version: 1,
      clientId: 'cid',
      clientSecret: 'sec',
      tokens: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() - 1,
        obtainedAt: Date.now() - 10_800_000,
        scope: ['read_thermostat'],
        clientId: 'cid',
      },
    }));
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const f = fakeFetch(async () => {
      await gate;
      return json(tokenResponse(2));
    });
    const tm = new TokenManager({ store, envClient: {}, logger: silentLogger, fetch: f });
    const ac = new AbortController();
    const waiting = tm.getAccessToken(ac.signal);
    await new Promise((r) => setTimeout(r, 20));
    ac.abort(new Error('tool call cancelled'));
    await expect(waiting).rejects.toThrow('tool call cancelled');
    release();
    await vi.waitFor(async () => {
      expect((await store.read())?.tokens?.refreshToken).toBe('refresh-2');
    });
    expect(await tm.getAccessToken()).toBe('access-2');
    expect(f.requests).toHaveLength(1);
  });
});

describe('M2: browser opener uses absolute paths', () => {
  it('does not resolve rundll32 or open through the current directory or PATH', () => {
    const [win] = browserCommand('win32');
    expect(path.win32.isAbsolute(win)).toBe(true);
    expect(win.toLowerCase()).toMatch(/system32\\rundll32\.exe$/);
    expect(browserCommand('darwin')[0]).toBe('/usr/bin/open');
  });
});

describe('L1: foreign folders are never re-permissioned', () => {
  it('recognises folders that only hold our files', async () => {
    expect(await containsOnlyOwnFiles(dir)).toBe(true);
    await fs.writeFile(path.join(dir, 'credentials.json'), '{}');
    await fs.mkdir(path.join(dir, 'probe'));
    await fs.writeFile(path.join(dir, 'changes.log'), '');
    await fs.writeFile(path.join(dir, 'credentials.lock.break'), '');
    expect(await containsOnlyOwnFiles(dir)).toBe(true);
    await fs.writeFile(path.join(dir, 'thesis.docx'), 'x');
    expect(await containsOnlyOwnFiles(dir)).toBe(false);
  });

  it('warns and leaves permissions unchanged on a folder with other content', async () => {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'x');
    const warn = vi.fn();
    const logger: Logger = { ...silentLogger, warn };
    const chmod = vi.spyOn(fs, 'chmod');
    const res = await ensureSecureDir(dir, logger, { forceAcl: true });
    expect(res).toEqual({ created: false });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/left unchanged/), { dir });
    expect(chmod).not.toHaveBeenCalled();
  });
});

describe('L2: stale lock breaking is race-safe', () => {
  it('never lets two holders in at once when several processes break a stale lock', async () => {
    const lock = path.join(dir, 'credentials.lock');
    await fs.writeFile(lock, 'crashed-holder');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        const release = await acquireFileLock(lock, { pollMs: 2, staleMs: 30_000 });
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await new Promise((r) => setTimeout(r, 5));
        inside -= 1;
        await release();
      }),
    );
    expect(maxInside).toBe(1);
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.stale'))).toEqual([]);
  });
});

describe('L3: probe sanitizer', () => {
  it('replaces identifiers embedded in free text and drops the country', () => {
    const san = new Sanitizer();
    const out = JSON.stringify(
      san.value({
        error: {
          message:
            'Device 70:ee:50:12:34:56 of home 5a1b2c3d4e5f6a7b8c9d0e1f not found (serial 70EE50ABCDEF, 70-ee-50-12-34-56)',
        },
        country: 'FR',
        timezone: 'Europe/Paris',
      }),
    );
    for (const leak of [
      '70:ee:50:12:34:56',
      '5a1b2c3d4e5f6a7b8c9d0e1f',
      '70EE50ABCDEF',
      '70-ee-50',
      '"FR"',
    ]) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain('Europe/Paris');
    // The same device gets the same placeholder whatever its notation.
    expect(san.text('70:ee:50:12:34:56')).toBe(san.text('70-EE-50-12-34-56'));
  });
});

describe('L4: logger redaction', () => {
  it('redacts OAuth codes, state, cookies and API keys but keeps numeric error codes', () => {
    expect(
      redact({
        code: 'auth-code-xyz',
        state: 'abc',
        cookie: 'c',
        api_key: 'k',
        id_token: 't',
        error: { code: 26 },
      }),
    ).toEqual({
      code: REDACTED,
      state: REDACTED,
      cookie: REDACTED,
      api_key: REDACTED,
      id_token: REDACTED,
      error: { code: 26 },
    });
  });

  it('redacts credentials in URL-encoded text and binary payloads', () => {
    expect(redactText('grant_type=refresh_token&refresh_token=abc.def&client_secret=s3cr3t')).toBe(
      `grant_type=refresh_token&refresh_token=${REDACTED}&client_secret=${REDACTED}`,
    );
    expect(redact({ body: Buffer.from('refresh_token=abc') })).toEqual({ body: '[binary]' });
  });
});

describe('callback server and manual login hardening', () => {
  it('rejects requests whose Host header is not a loopback name', async () => {
    const server = await startCallbackServer({
      redirectUri: 'http://127.0.0.1:8977/callback',
      expectedState: 's',
      port: 0,
      timeoutMs: 2000,
    });
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get(
          {
            host: '127.0.0.1',
            port: server.port,
            path: '/callback?state=s&code=c',
            headers: { Host: 'evil.example:8977' },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        )
        .on('error', reject);
    });
    expect(status).toBe(400);
    await server.close();
  });

  it('checks that a pasted redirect URL matches the registered redirect URI', () => {
    const uri = 'http://localhost:8977/callback';
    expect(parseRedirectUrl('http://localhost:8977/callback?state=s&code=c', 's', uri)).toBe('c');
    expect(() =>
      parseRedirectUrl('https://evil.example/callback?state=s&code=c', 's', uri),
    ).toThrow(OAuthError);
    expect(() => parseRedirectUrl('http://localhost:8977/other?state=s&code=c', 's', uri)).toThrow(
      /redirect URI/,
    );
  });
});
