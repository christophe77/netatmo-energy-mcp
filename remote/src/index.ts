/**
 * Remote Netatmo Energy MCP server on Cloudflare Workers (ADR-0013, ADR-0014).
 *
 * - /mcp: MCP endpoint, OAuth 2.1-protected; each request is served by the account's Durable
 *   Object with the same tools as the local server.
 * - /authorize: consent page; the owner signs in with OWNER_PASSWORD, or (ONBOARDING) someone
 *   connects their own Netatmo app. /netatmo/callback finishes onboarding.
 * - /admin/*: used by `netatmo-energy-mcp remote …`, authenticated with SETUP_TOKEN.
 */
import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  type AuthRequest,
  type ConsentDescription,
  type OAuthResourceContext,
} from '@cloudflare/workers-oauth-provider';
import { AppError } from '../../src/errors.js';
import { VERSION } from '../../src/version.js';
import { Account, AUTH_HEADER, type AuthFacts, type NetatmoLink } from './account.js';
import { publicOrigin, type Env } from './env.js';
import { clientKey, guard, Guard } from './guard.js';
import {
  callbackUrl,
  createInvite,
  netatmoCallback,
  onboardingMode,
  OWNER_ACCOUNT,
  startOnboarding,
} from './onboarding.js';
import { consentPage, escape, page } from './pages.js';

export { Account, Guard };

/** MCP scope granted to assistants; what they may do on Netatmo depends on the account link. */
const SCOPE = 'netatmo';
const MINUTE = 60_000;

interface Props {
  account: string;
}

const account = (env: Env, name: string) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName(name));

const tooMany = () =>
  page('Too many requests', '<h1>Too many requests</h1><p>Try again in a few minutes.</p>', 429);

// ------------------------------------------------------------------ MCP (token required)

const apiHandler = {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
    // OAuthProvider has verified the token for this resource and set props and auth.
    const ctx = executionCtx as OAuthResourceContext<Props | undefined>;
    if (!ctx.auth.scope.includes(SCOPE) || typeof ctx.props?.account !== 'string') {
      return new Response('Forbidden', { status: 403 });
    }
    const facts: AuthFacts = {
      clientId: ctx.auth.clientId ?? '',
      scopes: ctx.auth.scope,
      ...(ctx.auth.expiresAt !== undefined && { expiresAt: ctx.auth.expiresAt }),
    };
    const headers = new Headers(request.headers);
    headers.delete('Authorization'); // the account object never needs the bearer token
    headers.set(AUTH_HEADER, JSON.stringify(facts));
    return account(env, ctx.props.account).fetch(new Request(request, { headers }));
  },
};

// ------------------------------------------------------------------ consent

/**
 * Only clients whose identity can be checked may be approved: a Client ID Metadata Document
 * client has a verified domain (ChatGPT, Claude), and a loopback redirect stays on this
 * computer. A self-registered client's name is chosen by whoever registered it, so it could
 * impersonate ChatGPT to phish the owner password (security review M3).
 */
const clientAllowed = (env: Env, d: ConsentDescription) =>
  Boolean(d.clientDomain) || d.redirectIsLoopback || env.ALLOW_UNVERIFIED_CLIENTS === '1';

const blockedClient = (d: ConsentDescription) =>
  page(
    'Unverified app',
    `<h1>This app cannot be approved</h1><p>"${escape(d.clientName)}" registered itself and its identity cannot be verified (access would go to <strong>${escape(d.redirectHost)}</strong>). Only apps with a verified domain, such as ChatGPT and Claude, or apps on this computer can be approved.</p><p>If you trust it, the owner can allow unverified apps with ALLOW_UNVERIFIED_CLIENTS=1.</p>`,
    403,
  );

async function renderConsent(
  env: Env,
  authRequest: AuthRequest,
  error?: string,
): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const details = await oauth.describeConsent(authRequest);
  if (!clientAllowed(env, details)) return blockedClient(details);
  const consent = await oauth.beginConsent(authRequest);
  return page(
    `Authorize ${details.clientName}`,
    consentPage(details, consent.handle, {
      onboarding: onboardingMode(env),
      callbackUrl: callbackUrl(env),
      ...(error && { error }),
    }),
    error ? 401 : 200,
    consent.headers,
    // Validated by parseAuthRequest(): https, or http on loopback only. Onboarding forms
    // redirect to Netatmo's authorization page first.
    [
      new URL(authRequest.redirectUri).origin,
      ...(onboardingMode(env) === 'off' ? [] : ['https://api.netatmo.com']),
    ].join(' '),
  );
}

async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const client = await clientKey(request);
  try {
    if (request.method === 'GET') {
      if (!(await guard(env).allow('authorize-get', client, 60, 15 * MINUTE))) return tooMany();
      return await renderConsent(env, await oauth.parseAuthRequest(request));
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!(await guard(env).allow('authorize-post', client, 30, 15 * MINUTE))) return tooMany();

    const form = await request.formData();
    const handle = String(form.get('handle') ?? '');
    const decision = form.get('decision');
    if (decision !== 'approve' && decision !== 'onboard') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    // The consent handle and its browser cookie are checked first: nothing below runs for a
    // forged or replayed form, so it cannot be used to guess or lock the password.
    const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
    const details = await oauth.describeConsent(approved.request);
    if (!clientAllowed(env, details)) return blockedClient(details);
    if (decision === 'onboard') {
      const started = await startOnboarding(env, form, approved);
      return started instanceof Response
        ? started
        : await renderConsent(env, approved.request, started.error);
    }

    const check = await guard(env).checkSecret(
      'OWNER_PASSWORD',
      String(form.get('password') ?? ''),
      client,
    );
    if (check === 'locked') {
      return page(
        'Too many attempts',
        '<h1>Too many attempts</h1><p>Wrong password too many times. Try again in 15 minutes.</p>',
        429,
      );
    }
    if (check === 'wrong') return await renderConsent(env, approved.request, 'Wrong password.');

    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: OWNER_ACCOUNT,
      metadata: {},
      scope: approved.request.scope,
      props: { account: OWNER_ACCOUNT } satisfies Props,
    });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message =
        error instanceof AuthorizationError ? error.description : 'This app could not be verified.';
      return page('Authorization error', `<h1>Cannot continue</h1><p>${escape(message)}</p>`, 400);
    }
    throw error;
  }
}

/** Netatmo redirect after onboarding; invalid or replayed states are rendered, never redirected. */
async function callback(request: Request, env: Env): Promise<Response> {
  if (!(await guard(env).allow('callback', await clientKey(request), 20, 15 * MINUTE))) {
    return tooMany();
  }
  try {
    return await netatmoCallback(request, env, SCOPE);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return page(
        'Authorization error',
        `<h1>Cannot continue</h1><p>${escape(error.description)}</p>`,
        400,
      );
    }
    throw error;
  }
}

// ------------------------------------------------------------------ admin (CLI)

async function allGrants(env: Env, userId: string) {
  const grants = [];
  let cursor: string | undefined;
  do {
    const result = await env.OAUTH_PROVIDER.listUserGrants(userId, {
      limit: 100,
      ...(cursor && { cursor }),
    });
    grants.push(...result.items);
    cursor = result.cursor;
  } while (cursor);
  return grants;
}

async function revokeAll(env: Env, userId: string): Promise<number> {
  const grants = await allGrants(env, userId);
  for (const g of grants) await env.OAUTH_PROVIDER.revokeGrant(g.id, userId);
  return grants.length;
}

async function knownAccounts(env: Env): Promise<string[]> {
  const keys = (await guard(env).accounts()).map((a) => a.key);
  return keys.includes(OWNER_ACCOUNT) ? keys : [OWNER_ACCOUNT, ...keys];
}

async function admin(request: Request, env: Env, path: string): Promise<Response> {
  const json = (status: number, body: unknown) =>
    Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  const bearer = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1] ?? '';
  const check = await guard(env).checkSecret('SETUP_TOKEN', bearer, await clientKey(request));
  if (check === 'locked') {
    return json(429, { error: 'too_many_attempts', retry_after_seconds: 900 });
  }
  if (check !== 'ok') return json(401, { error: 'invalid_setup_token' });
  const body = async () =>
    (await request.json().catch(() => null)) as Record<string, unknown> | null;

  try {
    const owner = account(env, OWNER_ACCOUNT);
    if (path === '/admin/status' && request.method === 'GET') {
      return json(200, { version: VERSION, ...(await owner.status()) });
    }
    if (path === '/admin/setup' && request.method === 'POST') {
      const link = (await body()) as NetatmoLink | null;
      if (!link) return json(400, { error: 'invalid_json' });
      const result = await owner.setup(link);
      await guard(env).registerAccount(OWNER_ACCOUNT);
      return json(200, { version: VERSION, ...result });
    }
    if (path === '/admin/invite' && request.method === 'POST') {
      if (onboardingMode(env) !== 'invite') return json(409, { error: 'onboarding_not_invite' });
      return json(200, await createInvite(env));
    }
    if (path === '/admin/accounts' && request.method === 'GET') {
      const accounts = await Promise.all(
        (await knownAccounts(env)).map(async (key) => ({
          account: key,
          ...(await account(env, key).status()),
          connectors: (await allGrants(env, key)).map((g) => ({
            client_id: g.clientId,
            created_at: new Date(g.createdAt * 1000).toISOString(),
          })),
        })),
      );
      return json(200, { accounts });
    }
    if (path === '/admin/revoke' && request.method === 'POST') {
      const target = (await body())?.account;
      const keys = typeof target === 'string' ? [target] : await knownAccounts(env);
      let revoked = 0;
      for (const key of keys) revoked += await revokeAll(env, key);
      return json(200, { revoked });
    }
    if (path === '/admin/remove' && request.method === 'POST') {
      const target = (await body())?.account;
      if (typeof target !== 'string' || target === '') {
        return json(400, { error: 'account_required' });
      }
      const revoked = await revokeAll(env, target);
      await account(env, target).erase();
      await guard(env).removeAccount(target);
      return json(200, { removed: target, revoked });
    }
    return json(404, { error: 'not_found' });
  } catch (error) {
    // RPC errors lose their class; only a generic code and the message cross the boundary.
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof AppError ? error.code : 'SETUP_FAILED';
    return json(400, { error: code, message });
  }
}

// ------------------------------------------------------------------ routing

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/authorize') return authorize(request, env);
    if (pathname === '/netatmo/callback' && request.method === 'GET') return callback(request, env);
    if (pathname.startsWith('/admin/')) return admin(request, env, pathname);
    if (pathname === '/') {
      return page(
        'Netatmo Energy MCP',
        `<h1>Netatmo Energy MCP</h1><p>Remote MCP server, version ${escape(VERSION)}. Add <code>${escape(env.PUBLIC_URL)}/mcp</code> as a connector in your AI assistant.</p>`,
      );
    }
    return new Response('Not found', { status: 404 });
  },
};

let provider: OAuthProvider<Env> | undefined;

function getProvider(env: Env): OAuthProvider<Env> {
  // https in production; plain http only for the local emulator (wrangler dev).
  if (!/^(https:\/\/|http:\/\/localhost(:\d+)?$)/.test(env.PUBLIC_URL ?? '')) {
    throw new Error('PUBLIC_URL must be set to the https origin of this Worker.');
  }
  const origin = publicOrigin(env);
  provider ??= new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler,
    defaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [SCOPE, 'offline_access'],
    requiredScopes: [SCOPE],
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
    accessTokenTTL: 3600,
    onError: ({ code, status }) => {
      console.warn('OAuth error', status, code);
    },
  });
  return provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    // Dynamic client registration writes to storage for anyone: limit it per client.
    if (pathname === '/oauth/register' && request.method === 'POST') {
      if (!(await guard(env).allow('register', await clientKey(request), 20, 60 * MINUTE))) {
        return Response.json({ error: 'slow_down' }, { status: 429 });
      }
    }
    return getProvider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
