#!/usr/bin/env node
/**
 * End-to-end test of the remote server against the local Workers emulator and a fake Netatmo.
 *
 *   1. Starts a fake Netatmo API on 127.0.0.1:9877 (repository fixtures, token endpoint, writes).
 *   2. Starts `wrangler dev --env e2e` with test secrets (no Cloudflare account needed).
 *   3. Walks what the owner and an MCP client do: remote setup, OAuth (DCR + PKCE + consent),
 *      read tools, token refresh, write mode with the preview + token confirmation spread over
 *      two HTTP requests, and the secret lockout.
 *
 * Usage (from the repository root, after `pnpm install` and `npm install` in remote/):
 *   node remote/test/e2e.mjs
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const REMOTE = path.resolve(import.meta.dirname, '..');
const FIXTURES = path.resolve(REMOTE, '..', 'tests', 'fixtures');
const PORT = 8788;
const NETATMO_PORT = 9877;
const BASE = `http://localhost:${PORT}`;
const SECRETS = {
  PUBLIC_URL: BASE,
  OWNER_PASSWORD: 'e2e-owner-password-not-secret',
  SETUP_TOKEN: 'e2e-setup-token-not-secret',
  DATA_KEY: Buffer.from(randomBytes(32)).toString('base64'),
  NETATMO_API_BASE: `http://127.0.0.1:${NETATMO_PORT}`,
  LOG_LEVEL: 'warn',
};

let passed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`Check failed: ${label}`);
  passed++;
};

// ------------------------------------------------------------------ fake Netatmo

const fixture = (name) => readFileSync(path.join(FIXTURES, name), 'utf8');
const netatmo = { refreshes: 0, writes: [], tokens: new Set(['access-1']) };
const fake = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (status, text) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(text);
    };
    if (url.pathname === '/oauth2/token') {
      const form = new URLSearchParams(body);
      netatmo.refreshes++;
      const n = netatmo.refreshes + 1;
      netatmo.tokens.add(`access-${n}`);
      return send(
        200,
        JSON.stringify({
          access_token: `access-${n}`,
          refresh_token: `refresh-${n}`,
          expires_in: 10800,
          ...(form.get('grant_type') === 'refresh_token' ? {} : { scope: ['read_thermostat'] }),
        }),
      );
    }
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!netatmo.tokens.has(token))
      return send(403, JSON.stringify({ error: { code: 3, message: 'Access token expired' } }));
    if (url.pathname === '/api/homesdata') return send(200, fixture('homesdata.json'));
    if (url.pathname === '/api/homestatus') return send(200, fixture('homestatus.json'));
    if (req.method === 'POST') {
      netatmo.writes.push({ path: url.pathname, body });
      return send(
        200,
        JSON.stringify({ status: 'ok', time_server: Math.floor(Date.now() / 1000) }),
      );
    }
    return send(404, JSON.stringify({ error: { code: 31, message: 'not found' } }));
  });
});
await new Promise((r) => fake.listen(NETATMO_PORT, '127.0.0.1', r));

// ------------------------------------------------------------------ worker

const devVars = path.join(REMOTE, '.dev.vars.e2e');
writeFileSync(
  devVars,
  Object.entries(SECRETS)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n'),
);
const wrangler = spawn(
  'npx',
  [
    'wrangler',
    'dev',
    '--env',
    'e2e',
    '--port',
    String(PORT),
    '--local',
    '--persist-to',
    '.wrangler/e2e-state',
  ],
  {
    cwd: REMOTE,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let workerLog = '';
wrangler.stdout.on('data', (d) => (workerLog += d));
wrangler.stderr.on('data', (d) => (workerLog += d));

async function cleanup() {
  fake.close();
  rmSync(devVars, { force: true });
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(wrangler.pid), '/T', '/F']);
  else wrangler.kill();
}

try {
  for (let i = 0; i < 60; i++) {
    const up = await fetch(`${BASE}/`)
      .then((r) => r.ok)
      .catch(() => false);
    if (up) break;
    await new Promise((r) => setTimeout(r, 1000));
    if (i === 59) throw new Error(`Worker did not start:\n${workerLog}`);
  }

  // ---------------------------------------------------------------- admin (owner setup)
  const admin = (p, token, init = {}) =>
    fetch(`${BASE}${p}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
  check(
    (await admin('/admin/status', 'wrong-token-1234')).status === 401,
    'admin refuses a wrong setup token',
  );
  const before = await (await admin('/admin/status', SECRETS.SETUP_TOKEN)).json();
  check(before.linked === false, 'owner account starts unlinked');

  const link = (scope, expiresAt) => ({
    clientId: 'e2e-client',
    clientSecret: 'e2e-secret',
    tokens: {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt,
      obtainedAt: Date.now(),
      scope,
    },
  });
  const setup = await admin('/admin/setup', SECRETS.SETUP_TOKEN, {
    method: 'POST',
    body: JSON.stringify(link(['read_thermostat'], Date.now() + 3_600_000)),
  });
  const linked = await setup.json();
  check(
    setup.status === 200 && linked.linked && linked.homes === 1,
    'remote setup links the account',
    JSON.stringify({ homes: linked.homes, write: linked.writeMode }),
  );
  check(
    !JSON.stringify(linked).includes('e2e-secret') && !JSON.stringify(linked).includes('access-1'),
    'setup response contains no secret',
  );

  // ---------------------------------------------------------------- OAuth as an MCP client
  async function connect() {
    const prmUrl = /resource_metadata="([^"]+)"/.exec(
      (
        await fetch(`${BASE}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).headers.get('www-authenticate') ?? '',
    )?.[1];
    const prm = await (await fetch(prmUrl)).json();
    const as = await (
      await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)
    ).json();
    const redirect = 'http://localhost:9999/callback';
    const reg = await (
      await fetch(as.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'e2e',
          redirect_uris: [redirect],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
      })
    ).json();
    const verifier = randomBytes(32).toString('base64url');
    const authUrl = new URL(as.authorization_endpoint);
    Object.entries({
      response_type: 'code',
      client_id: reg.client_id,
      redirect_uri: redirect,
      scope: prm.scopes_supported.join(' '),
      state: 's1',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: prm.resource,
    }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
    const consent = await fetch(authUrl);
    const cookies = consent.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())?.[1];
    const post = (password) =>
      fetch(authUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookies },
        body: new URLSearchParams({ handle, decision: 'approve', password }),
      });
    return { as, reg, verifier, redirect, post, prm };
  }
  const c1 = await connect();
  check(
    (await c1.post('wrong-password-123')).status === 403,
    'consent refuses a wrong owner password',
  );
  const approved = await c1.post(SECRETS.OWNER_PASSWORD);
  const code = new URL(approved.headers.get('location')).searchParams.get('code');
  const tok = await (
    await fetch(c1.as.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: c1.redirect,
        client_id: c1.reg.client_id,
        code_verifier: c1.verifier,
        resource: c1.prm.resource,
      }),
    })
  ).json();
  check(typeof tok.access_token === 'string', 'MCP client obtains a token with the owner password');

  async function mcp(era) {
    const client = new Client(
      { name: 'e2e', version: '0' },
      era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } },
      }),
    );
    return client;
  }
  const call = async (client, name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { ...res, body: JSON.parse(res.content[0].text) };
  };

  // ---------------------------------------------------------------- read tools
  for (const era of ['legacy', 'modern']) {
    const client = await mcp(era);
    const { tools } = await client.listTools();
    check(
      tools.length === 15 && tools.every((t) => t.annotations?.readOnlyHint),
      `${era}: 15 read-only tools (no write scope)`,
    );
    const homes = await call(client, 'netatmo_list_homes');
    check(
      !homes.isError && homes.body.homes?.[0]?.name === 'Test Home',
      `${era}: netatmo_list_homes returns the home`,
    );
    const status = await call(client, 'netatmo_get_home_status');
    check(
      !status.isError && Array.isArray(status.body.rooms),
      `${era}: netatmo_get_home_status works`,
    );
    await client.close();
  }

  // ---------------------------------------------------------------- token refresh
  // Setup with already-expired tokens: the account refreshes once (setup verifies the link).
  const refreshesBefore = netatmo.refreshes;
  await admin('/admin/setup', SECRETS.SETUP_TOKEN, {
    method: 'POST',
    body: JSON.stringify(link(['read_thermostat'], Date.now() - 1000)),
  });
  {
    const client = await mcp('modern');
    const [a, b] = await Promise.all([
      call(client, 'netatmo_list_rooms'),
      call(client, 'netatmo_list_devices'),
    ]);
    check(!a.isError && !b.isError, 'tools work with expired Netatmo tokens');
    check(
      netatmo.refreshes === refreshesBefore + 1,
      'expired tokens refreshed exactly once, then reused',
      String(netatmo.refreshes - refreshesBefore),
    );
    await client.close();
  }
  const after = await (await admin('/admin/status', SECRETS.SETUP_TOKEN)).json();
  check(after.scopes.includes('read_thermostat'), 'scope kept when the refresh response omits it');

  // ---------------------------------------------------------------- write mode, token confirmation
  await admin('/admin/setup', SECRETS.SETUP_TOKEN, {
    method: 'POST',
    body: JSON.stringify(link(['read_thermostat', 'write_thermostat'], Date.now() + 3_600_000)),
  });
  {
    const client = await mcp('modern');
    const { tools } = await client.listTools();
    check(tools.length === 21, 'write mode: 21 tools after setup with write_thermostat');
    const preview = await call(client, 'netatmo_set_home_mode', { mode: 'frost_guard' });
    check(
      preview.body.status === 'confirmation_required' && netatmo.writes.length === 0,
      'first call only previews (nothing sent)',
    );
    // Second call is a separate HTTP request served by a fresh McpServer instance.
    const applied = await call(client, 'netatmo_set_home_mode', {
      mode: 'frost_guard',
      confirmation_token: preview.body.confirmation_token,
    });
    check(
      applied.body.status === 'applied' &&
        netatmo.writes.length === 1 &&
        netatmo.writes[0].path === '/api/setthermmode',
      'confirmation token works across requests; one write sent',
    );
    const replay = await call(client, 'netatmo_set_home_mode', {
      mode: 'frost_guard',
      confirmation_token: preview.body.confirmation_token,
    });
    check(replay.isError && netatmo.writes.length === 1, 'a used confirmation token is refused');
    const outOfRange = await call(client, 'netatmo_set_room_setpoint', {
      room_name: 'bureau',
      mode: 'manual',
      temperature: 35,
    });
    check(
      outOfRange.isError && /between 7 and 28/.test(outOfRange.body.error.message),
      'write limits apply remotely',
    );
    await client.close();
  }

  // ---------------------------------------------------------------- lockout
  let last;
  for (let i = 0; i < 6; i++) last = await admin('/admin/status', `wrong-token-${i}xxxxxx`);
  check(last.status === 429, 'setup token locked after repeated failures');
  check(
    (await admin('/admin/status', SECRETS.SETUP_TOKEN)).status === 429,
    'even the right token waits out the lockout',
  );

  console.log(`\nAll ${passed} checks passed.`);
} catch (error) {
  console.error(error.message);
  console.error('--- worker log (tail) ---\n' + workerLog.split('\n').slice(-40).join('\n'));
  process.exitCode = 1;
} finally {
  await cleanup();
}
