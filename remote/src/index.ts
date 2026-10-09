/**
 * Remote Netatmo Energy MCP server on Cloudflare Workers (ADR-0013, ADR-0014).
 *
 * - /mcp: MCP endpoint, OAuth 2.1-protected; each request is served by the account's Durable
 *   Object with the same tools as the local server.
 * - /authorize: consent page; the owner signs in with OWNER_PASSWORD.
 * - /admin/setup, /admin/status: used by `netatmo-energy-mcp remote setup|status`, authenticated
 *   with SETUP_TOKEN.
 */
import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  type OAuthResourceContext,
} from '@cloudflare/workers-oauth-provider';
import { AppError } from '../../src/errors.js';
import { VERSION } from '../../src/version.js';
import {
  Account,
  AUTH_HEADER,
  type AuthFacts,
  type NetatmoLink,
  type SecretCheck,
} from './account.js';
import type { Env } from './env.js';
import {
  callbackUrl,
  createInvite,
  netatmoCallback,
  onboardingMode,
  startOnboarding,
} from './onboarding.js';
import { consentPage, escape, page } from './pages.js';

export { Account };

/** MCP scope granted to assistants; what they may do on Netatmo depends on the account link. */
const SCOPE = 'netatmo';
/** The pre-configured owner account (ADR-0014 §2). Onboarded accounts come in a later phase. */
const OWNER = 'owner';

interface Props {
  account: string;
}

const account = (env: Env, name: string) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName(name));

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

async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return page(
        `Authorize ${details.clientName}`,
        consentPage(details, consent.handle, {
          onboarding: onboardingMode(env),
          callbackUrl: callbackUrl(env),
        }),
        200,
        consent.headers,
        // Validated by parseAuthRequest(): https, or http on loopback only. Onboarding forms
        // redirect to Netatmo's authorization page first.
        [
          new URL(authRequest.redirectUri).origin,
          ...(onboardingMode(env) === 'off' ? [] : ['https://api.netatmo.com']),
        ].join(' '),
      );
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const form = await request.formData();
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') === 'onboard') {
      return startOnboarding(request, env, form, handle, SCOPE);
    }
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const check = await account(env, OWNER).checkSecret(
      'OWNER_PASSWORD',
      String(form.get('password') ?? ''),
    );
    if (check !== 'ok') return secretRefused(check, 'password');

    const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: OWNER,
      metadata: {},
      scope: approved.request.scope,
      props: { account: OWNER } satisfies Props,
    });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo)
      return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message =
        error instanceof AuthorizationError ? error.description : 'This app could not be verified.';
      return page('Authorization error', `<h1>Cannot continue</h1><p>${escape(message)}</p>`, 400);
    }
    throw error;
  }
}

function secretRefused(check: Exclude<SecretCheck, 'ok'>, what: string): Response {
  return check === 'locked'
    ? page(
        'Too many attempts',
        `<h1>Too many attempts</h1><p>Wrong ${what} too many times. Try again in 15 minutes.</p>`,
        429,
      )
    : page(`Wrong ${what}`, `<h1>Wrong ${what}</h1><p>Go back and try again.</p>`, 403);
}

/** Netatmo redirect after onboarding; invalid or replayed states are rendered, never redirected. */
async function callback(request: Request, env: Env): Promise<Response> {
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

async function admin(request: Request, env: Env, path: string): Promise<Response> {
  const json = (status: number, body: unknown) =>
    Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  const bearer = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1] ?? '';
  const owner = account(env, OWNER);
  const check = await owner.checkSecret('SETUP_TOKEN', bearer);
  if (check === 'locked')
    return json(429, { error: 'too_many_attempts', retry_after_seconds: 900 });
  if (check !== 'ok') return json(401, { error: 'invalid_setup_token' });

  try {
    if (path === '/admin/status' && request.method === 'GET') {
      return json(200, { version: VERSION, ...(await owner.status()) });
    }
    if (path === '/admin/invite' && request.method === 'POST') {
      if (onboardingMode(env) !== 'invite') return json(409, { error: 'onboarding_not_invite' });
      return json(200, await createInvite(env));
    }
    if (path === '/admin/setup' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as NetatmoLink | null;
      if (!body) return json(400, { error: 'invalid_json' });
      return json(200, { version: VERSION, ...(await owner.setup(body)) });
    }
    return json(405, { error: 'method_not_allowed' });
  } catch (error) {
    // RPC errors lose their class; AppError subclasses keep `code` in the message prefix.
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
  const origin = env.PUBLIC_URL.replace(/\/+$/, '');
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
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return getProvider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
