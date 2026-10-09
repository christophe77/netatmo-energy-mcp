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
  SETUP_TOKEN: 'e2e-setup-token-not-secret-0123456789',
  DATA_KEY: Buffer.from(randomBytes(32)).toString('base64'),
  NETATMO_API_BASE: `http://127.0.0.1:${NETATMO_PORT}`,
  ONBOARDING: 'invite',
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
      if (form.get('grant_type') === 'authorization_code') {
        if (
          form.get('code') !== 'second-user-code' ||
          form.get('client_id') !== 'second-client-id'
        ) {
          return send(400, JSON.stringify({ error: 'invalid_grant' }));
        }
        netatmo.tokens.add('u2-access');
        return send(
          200,
          JSON.stringify({
            access_token: 'u2-access',
            refresh_token: 'u2-refresh',
            expires_in: 10800,
            scope: ['read_thermostat'],
          }),
        );
      }
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
    if (url.pathname === '/api/homesdata') {
      if (token !== 'u2-access') return send(200, fixture('homesdata.json'));
      const second = JSON.parse(fixture('homesdata.json'));
      second.body.user.id = 'second-netatmo-user';
      second.body.homes[0].name = 'Second Home';
      return send(200, JSON.stringify(second));
    }
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
// Fresh state on every run: a previous run's lockouts and accounts must not leak in.
rmSync(path.join(REMOTE, '.wrangler', 'e2e-state'), { recursive: true, force: true });
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
    // Own process group on POSIX, so cleanup can stop npx, wrangler and workerd together.
    detached: process.platform !== 'win32',
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
  else {
    try {
      process.kill(-wrangler.pid, 'SIGTERM');
    } catch {
      wrangler.kill('SIGTERM');
    }
  }
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
    const consentHtml = await consent.text();
    const handle = /name="handle" value="([^"]+)"/.exec(consentHtml)?.[1];
    const post = (password) =>
      fetch(authUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookies },
        body: new URLSearchParams({ handle, decision: 'approve', password }),
      });
    return { as, reg, verifier, redirect, post, prm, authUrl, cookies, handle, html: consentHtml };
  }
  const c1 = await connect();
  // Forms without a valid consent session never reach the password check (security review M1).
  let forged;
  for (let i = 0; i < 6; i++) {
    forged = await fetch(c1.authUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ handle: 'forged', decision: 'approve', password: 'x' }),
    });
  }
  check(forged.status === 400, 'forged consent forms are refused before any password check');
  const wrong = await c1.post('wrong-password-123');
  const retryHtml = await wrong.text();
  check(
    wrong.status === 401 && retryHtml.includes('Wrong password.'),
    'wrong owner password re-renders the consent page',
  );
  const retryHandle = /name="handle" value="([^"]+)"/.exec(retryHtml)?.[1];
  const retryCookies = [
    c1.cookies,
    ...wrong.headers.getSetCookie().map((c) => c.split(';')[0]),
  ].join('; ');
  const approved = await fetch(c1.authUrl, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: retryCookies },
    body: new URLSearchParams({
      handle: retryHandle,
      decision: 'approve',
      password: SECRETS.OWNER_PASSWORD,
    }),
  });
  check(
    approved.status === 302,
    'owner approves with the right password (not locked by the forged forms)',
  );
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

  // ---------------------------------------------------------------- onboarding (invite)
  {
    const invite = await (
      await admin('/admin/invite', SECRETS.SETUP_TOKEN, { method: 'POST' })
    ).json();
    check(typeof invite.code === 'string', 'owner creates an invite code');
    const c2 = await connect();
    check(
      c2.html.includes('connect your own Netatmo account') && c2.html.includes('/netatmo/callback'),
      'consent page offers onboarding with the callback URL',
    );
    const onboard = (code) =>
      fetch(c2.authUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: c2.cookies },
        body: new URLSearchParams({
          handle: c2.handle,
          decision: 'onboard',
          client_id: 'second-client-id',
          client_secret: 'second-secret-123',
          invite: code,
        }),
      });
    const badInvite = await onboard('not-a-real-invite');
    const badHtml = await badInvite.text();
    check(
      badInvite.status === 401 && badHtml.includes('unknown, expired or already used'),
      'unknown invite code refused, form shown again',
    );
    // Continue with the fresh consent session from the re-rendered page.
    c2.handle = /name="handle" value="([^"]+)"/.exec(badHtml)?.[1];
    c2.cookies = [c2.cookies, ...badInvite.headers.getSetCookie().map((c) => c.split(';')[0])].join(
      '; ',
    );
    const toNetatmo = await onboard(invite.code);
    const netatmoUrl = new URL(toNetatmo.headers.get('location') ?? 'http://x/');
    check(
      toNetatmo.status === 302 &&
        netatmoUrl.host === 'api.netatmo.com' &&
        netatmoUrl.searchParams.get('redirect_uri') === `${BASE}/netatmo/callback`,
      'redirects to Netatmo with the callback URL',
    );
    check(
      netatmoUrl.searchParams.get('client_id') === 'second-client-id' &&
        !netatmoUrl.href.includes('second-secret'),
      'Netatmo URL carries the client ID, never the secret',
    );
    const upstreamCookies = [
      c2.cookies,
      ...toNetatmo.headers.getSetCookie().map((c) => c.split(';')[0]),
    ].join('; ');
    const state = netatmoUrl.searchParams.get('state');
    const callback = (cookie) =>
      fetch(`${BASE}/netatmo/callback?code=second-user-code&state=${encodeURIComponent(state)}`, {
        redirect: 'manual',
        headers: { cookie },
      });
    check(
      (await callback(c2.cookies)).status === 400,
      'callback refused without the browser binding cookie',
    );
    const back = await callback(upstreamCookies);
    const clientRedirect = new URL(back.headers.get('location') ?? 'http://x/');
    const code2 = clientRedirect.searchParams.get('code');
    check(
      back.status === 302 && clientRedirect.origin === 'http://localhost:9999' && Boolean(code2),
      'callback links the account and returns to the MCP client',
    );
    check((await callback(upstreamCookies)).status === 400, 'callback state is single-use');
    const tok2 = await (
      await fetch(c2.as.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code2,
          redirect_uri: c2.redirect,
          client_id: c2.reg.client_id,
          code_verifier: c2.verifier,
          resource: c2.prm.resource,
        }),
      })
    ).json();
    const second = new Client({ name: 'e2e-2', version: '0' });
    await second.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${tok2.access_token}` } },
      }),
    );
    const homes2 = await call(second, 'netatmo_list_homes');
    check(homes2.body.homes?.[0]?.name === 'Second Home', 'onboarded account sees its own home');
    const { tools: tools2 } = await second.listTools();
    check(tools2.length === 15, 'onboarded read-only account has the 15 read tools');
    await second.close();

    // Accounts, revocation and removal (security review M2).
    const { accounts } = await (await admin('/admin/accounts', SECRETS.SETUP_TOKEN)).json();
    const onboardedKey = accounts.find((a) => a.account !== 'owner')?.account;
    check(
      accounts.length === 2 &&
        /^u_/.test(onboardedKey ?? '') &&
        accounts.every((a) => a.connectors.length >= 1),
      'admin lists the owner and the onboarded account with their connectors',
    );
    check(
      !JSON.stringify(accounts).includes('second-secret') &&
        !JSON.stringify(accounts).includes('u2-access'),
      'account list contains no secret',
    );
    const revoked = await (
      await admin('/admin/revoke', SECRETS.SETUP_TOKEN, {
        method: 'POST',
        body: JSON.stringify({ account: onboardedKey }),
      })
    ).json();
    const afterRevoke = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tok2.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    check(
      revoked.revoked >= 1 && afterRevoke.status === 401,
      'revoking an account cuts its connectors off immediately',
    );
    const ownerStill = await mcp('modern');
    check(
      (await call(ownerStill, 'netatmo_list_homes')).body.homes?.[0]?.name === 'Test Home',
      'the owner is not affected',
    );
    await ownerStill.close();
    const removed = await (
      await admin('/admin/remove', SECRETS.SETUP_TOKEN, {
        method: 'POST',
        body: JSON.stringify({ account: onboardedKey }),
      })
    ).json();
    const remaining = (await (await admin('/admin/accounts', SECRETS.SETUP_TOKEN)).json()).accounts;
    check(
      removed.removed === onboardedKey && remaining.length === 1,
      'removing an account erases it',
    );
    const ownerAgain = await mcp('modern');
    check(
      (await call(ownerAgain, 'netatmo_list_homes')).body.homes?.[0]?.name === 'Test Home',
      "owner still sees only the owner's home",
    );
    await ownerAgain.close();
    const c3 = await connect();
    const reuse = await fetch(c3.authUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: c3.cookies },
      body: new URLSearchParams({
        handle: c3.handle,
        decision: 'onboard',
        client_id: 'second-client-id',
        client_secret: 'second-secret-123',
        invite: invite.code,
      }),
    });
    check(
      reuse.status === 401 && (await reuse.text()).includes('already used'),
      'invite code is single-use',
    );
  }

  // ---------------------------------------------------------------- unverified clients (M3)
  {
    const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
    const evil = await (
      await fetch(as.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'ChatGPT',
          redirect_uris: ['https://evil.example/cb'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code'],
          response_types: ['code'],
        }),
      })
    ).json();
    const url = new URL(as.authorization_endpoint);
    Object.entries({
      response_type: 'code',
      client_id: evil.client_id,
      redirect_uri: 'https://evil.example/cb',
      scope: 'netatmo',
      state: 'x',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    }).forEach(([k, v]) => url.searchParams.set(k, v));
    const page = await fetch(url);
    const html = await page.text();
    check(
      page.status === 403 &&
        html.includes('cannot be approved') &&
        !html.includes('name="password"'),
      'self-registered client with a remote redirect cannot be approved',
    );
  }

  // ---------------------------------------------------------------- lockout per client (M1)
  const fromAttacker = { headers: { 'CF-Connecting-IP': '203.0.113.9' } };
  let last;
  for (let i = 0; i < 6; i++)
    last = await admin('/admin/status', `wrong-token-${i}xxxxxx`, fromAttacker);
  check(last.status === 429, 'setup token locked for a client after repeated failures');
  check(
    (await admin('/admin/status', SECRETS.SETUP_TOKEN, fromAttacker)).status === 429,
    'that client waits out the lockout even with the right token',
  );
  check(
    (await admin('/admin/status', SECRETS.SETUP_TOKEN)).status === 200,
    'the owner elsewhere is not locked out',
  );

  console.log(`\nAll ${passed} checks passed.`);
} catch (error) {
  console.error(error.message);
  console.error('--- worker log (tail) ---\n' + workerLog.split('\n').slice(-40).join('\n'));
  process.exitCode = 1;
} finally {
  await cleanup();
  // Child pipes may linger briefly after the emulator is stopped; do not wait on them.
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  wrangler.stdout.destroy();
  wrangler.stderr.destroy();
}
