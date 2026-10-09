#!/usr/bin/env node
/**
 * End-to-end check of the spike, doing what a remote MCP client (ChatGPT, Claude) does:
 * discovery from a 401, dynamic client registration, authorization with PKCE through the
 * consent page (owner password), code exchange, then MCP calls in both protocol eras.
 *
 * Usage: SPIKE_URL=https://… SPIKE_PASSWORD=… node e2e.mjs
 * (defaults: the local emulator, http://localhost:8787, and the .dev.vars test password)
 * Run from this folder; it uses @modelcontextprotocol/client from the repository root.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const BASE = (process.env.SPIKE_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const PASSWORD = process.env.SPIKE_PASSWORD ?? 'local-test-password-not-a-secret';
const REDIRECT = 'http://localhost:9876/callback'; // never contacted: we read the code from Location
const results = [];
const check = (ok, label, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(label);
};

/** Minimal cookie jar: the consent page binds its form to a browser cookie. */
const jar = new Map();
const keepCookies = (res) => {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
};
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

// 1. Unauthenticated MCP request → 401 pointing at the protected resource metadata.
const unauth = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
const challenge = unauth.headers.get('www-authenticate') ?? '';
check(
  unauth.status === 401 && challenge.includes('resource_metadata'),
  '401 with resource_metadata challenge',
);
const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
const prm = await (await fetch(prmUrl)).json();
check(prm.resource === `${BASE}/mcp`, 'protected resource metadata names /mcp', prm.resource);
const asMeta = await (
  await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)
).json();
check(
  Boolean(asMeta.registration_endpoint && asMeta.authorization_endpoint && asMeta.token_endpoint),
  'authorization server metadata',
);
check(asMeta.code_challenge_methods_supported?.includes('S256'), 'PKCE S256 advertised');

// 2. Dynamic client registration (RFC 7591), as Claude does.
const reg = await (
  await fetch(asMeta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'spike e2e',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  })
).json();
check(typeof reg.client_id === 'string', 'dynamic client registration', reg.client_id?.slice(0, 8));

// 3. Authorization request with PKCE → consent page.
const verifier = randomBytes(32).toString('base64url');
const challengeS256 = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(8).toString('hex');
const authUrl = new URL(asMeta.authorization_endpoint);
for (const [k, v] of Object.entries({
  response_type: 'code',
  client_id: reg.client_id,
  redirect_uri: REDIRECT,
  scope: 'mcp:read offline_access',
  state,
  code_challenge: challengeS256,
  code_challenge_method: 'S256',
  resource: `${BASE}/mcp`,
}))
  authUrl.searchParams.set(k, v);
const consent = await fetch(authUrl, { redirect: 'manual' });
keepCookies(consent);
const html = await consent.text();
const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
check(consent.status === 200 && Boolean(handle), 'consent page with a form handle');
check(html.includes('localhost'), 'consent page shows the redirect host');

const post = (fields) =>
  fetch(authUrl, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(),
      origin: BASE,
    },
    body: new URLSearchParams(fields),
  });

// 4. Wrong password is refused; the right one yields a code.
const wrong = await post({ handle, decision: 'approve', password: 'wrong' });
check(wrong.status === 403, 'wrong password refused');
const approved = await post({ handle, decision: 'approve', password: PASSWORD });
const location = new URL(approved.headers.get('location') ?? 'http://x/');
check(
  approved.status === 302 && location.searchParams.get('state') === state,
  'redirect back with state',
);
const code = location.searchParams.get('code');
check(Boolean(code), 'authorization code issued');

// 5. Token exchange with the PKCE verifier.
const tok = await (
  await fetch(asMeta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: reg.client_id,
      code_verifier: verifier,
      resource: `${BASE}/mcp`,
    }),
  })
).json();
check(
  typeof tok.access_token === 'string' && typeof tok.refresh_token === 'string',
  'access and refresh tokens',
);

// 6. MCP calls with the token, in both protocol eras.
for (const era of ['legacy', 'modern']) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } },
  });
  const client = new Client(
    { name: 'spike-e2e', version: '0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(transport);
  const { tools } = await client.listTools();
  check(
    tools.some((t) => t.name === 'spike_whoami'),
    `${era}: tools/list`,
  );
  const res = await client.callTool({ name: 'spike_whoami', arguments: {} });
  check(
    res.structuredContent?.account === 'spike-owner',
    `${era}: tools/call spike_whoami`,
    JSON.stringify(res.structuredContent?.account),
  );
  await client.close();
}

// 7. A forged token is rejected.
const forged = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: 'Bearer x:y:z',
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
check(forged.status === 401, 'forged token rejected');

// 8. Replaying the authorization code fails and (OAuth 2.1) revokes the tokens it issued.
const replay = await fetch(asMeta.token_endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: reg.client_id,
    code_verifier: verifier,
  }),
});
check(replay.status === 400, 'authorization code is single-use');
const afterReplay = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${tok.access_token}`,
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
check(afterReplay.status === 401, 'tokens revoked after the code was replayed');

console.log(`\nAll ${results.length} checks passed against ${BASE}`);
