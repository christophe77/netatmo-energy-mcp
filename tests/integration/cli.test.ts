import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore } from '../../src/auth/credential-store.js';
import { runCli } from '../../src/cli/index.js';
import type { Output } from '../../src/cli/output.js';
import { configPaths } from '../../src/config/paths.js';
import { silentLogger } from '../../src/utils/logger.js';
import { fakeFetch, json, tokenResponse, type RecordedRequest } from '../helpers/fake-fetch.js';
import { fixture } from '../helpers/fakes.js';

let dir: string;
let cfg: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'nem-cli-'));
  cfg = path.join(dir, 'cfg');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true });
});

function capture(): Output & { text: () => string } {
  const lines: string[] = [];
  return {
    line: (t = '') => lines.push(t),
    error: (t) => lines.push(t),
    text: () => lines.join('\n'),
  };
}

function netatmo(req: RecordedRequest) {
  if (req.url.pathname === '/oauth2/token') return json(tokenResponse(2));
  if (req.url.pathname === '/api/homesdata') return json(fixture('homesdata.json'));
  return json({ error: { code: 31, message: 'not found' } }, 404);
}

async function seed(expiresAt = Date.now() + 3 * 3_600_000) {
  await new CredentialStore(configPaths(cfg), silentLogger).update(() => ({
    version: 1,
    clientId: 'client-id-123456',
    clientSecret: 'very-secret-value',
    tokens: {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt,
      obtainedAt: Date.now(),
      scope: ['read_thermostat'],
      clientId: 'client-id-123456',
    },
  }));
}

const SECRETS = ['very-secret-value', 'access-1', 'refresh-1', 'access-2', 'refresh-2'];

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise((r) => server.close(r));
  return port;
}

function httpGet(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on('error', reject);
  });
}

describe('CLI commands', () => {
  it('status reports "not logged in" without credentials', async () => {
    const out = capture();
    expect(await runCli(['status'], { NETATMO_MCP_CONFIG_DIR: cfg }, out)).toBe(1);
    expect(out.text()).toMatch(/not logged in/);
  });

  it('status masks the client ID and never prints secrets', async () => {
    await seed();
    const out = capture();
    expect(await runCli(['status'], { NETATMO_MCP_CONFIG_DIR: cfg }, out)).toBe(0);
    expect(out.text()).toMatch(/clie…56 \(from stored credentials\)/);
    expect(out.text()).toMatch(/expires in 3 h/);
    for (const s of [...SECRETS, 'client-id-123456']) expect(out.text()).not.toContain(s);
  });

  it('doctor checks credentials, refreshes if needed and calls the API', async () => {
    await seed(Date.now() - 1000); // expired: forces a refresh
    vi.stubGlobal('fetch', fakeFetch(netatmo));
    const out = capture();
    const code = await runCli(['doctor'], { NETATMO_MCP_CONFIG_DIR: cfg }, out);
    expect(out.text()).toMatch(/Access token valid for/);
    expect(out.text()).toMatch(/Netatmo API reachable: 1 home/);
    expect(out.text()).toMatch(/Granted scope: read_thermostat/);
    expect(code).toBe(0);
    for (const s of SECRETS) expect(out.text()).not.toContain(s);
  });

  it('logout removes stored credentials', async () => {
    await seed();
    const out = capture();
    expect(await runCli(['logout'], { NETATMO_MCP_CONFIG_DIR: cfg }, out)).toBe(0);
    expect(out.text()).toMatch(/Removed/);
    expect(await new CredentialStore(configPaths(cfg), silentLogger).read()).toBeUndefined();
  });

  it('login refuses to run non-interactively without client credentials', async () => {
    const out = capture();
    expect(await runCli(['login'], { NETATMO_MCP_CONFIG_DIR: cfg }, out)).toBe(2);
    expect(out.text()).toMatch(/NETATMO_CLIENT_ID/);
  });

  it('login completes the browser flow through the loopback callback', async () => {
    const port = await freePort();
    vi.stubGlobal('fetch', fakeFetch(netatmo));
    const out = capture();
    const env = {
      NETATMO_MCP_CONFIG_DIR: cfg,
      NETATMO_CLIENT_ID: 'client-id-123456',
      NETATMO_CLIENT_SECRET: 'very-secret-value',
      NETATMO_REDIRECT_URI: `http://127.0.0.1:${port}/callback`,
    };
    const run = runCli(['login', '--no-browser'], env, out);

    // Wait for the authorization URL, then play the browser.
    let authorize: URL | undefined;
    for (let i = 0; i < 100 && !authorize; i++) {
      const match = /https:\/\/api\.netatmo\.com\/oauth2\/authorize\S+/.exec(out.text());
      if (match) authorize = new URL(match[0]);
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(authorize?.searchParams.get('scope')).toBe('read_thermostat');
    const state = authorize!.searchParams.get('state')!;
    expect(await httpGet(`http://127.0.0.1:${port}/callback?state=forged&code=evil`)).toBe(400);
    expect(await httpGet(`http://127.0.0.1:${port}/callback?state=${state}&code=good-code`)).toBe(
      200,
    );

    expect(await run).toBe(0);
    expect(out.text()).toMatch(/Logged in/);
    expect(out.text()).toMatch(/Found 1 home/);
    expect(out.text()).toMatch(/Boiler history: available via thermostat type NATherm1/);
    for (const s of SECRETS) expect(out.text()).not.toContain(s);
    const stored = await new CredentialStore(configPaths(cfg), silentLogger).read();
    expect(stored).toMatchObject({
      clientId: 'client-id-123456',
      tokens: { refreshToken: 'refresh-2' },
    });
  });
});
