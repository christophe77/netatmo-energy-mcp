/**
 * ADR-0013 spike: a remote MCP endpoint behind OAuth 2.1 on Cloudflare Workers.
 *
 * Goal: prove that ChatGPT and Claude (web and mobile) can register, complete the OAuth flow
 * and call a tool on this endpoint. It deliberately holds NO Netatmo access and NO user data:
 * the only tool reports who the server thinks is calling. Sign-in is a stub (one owner
 * password); the real onboarding (bring-your-own Netatmo app) comes in 0.3.
 */
import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  type ConsentDescription,
  type OAuthHelpers,
  type OAuthResourceContext,
} from '@cloudflare/workers-oauth-provider';
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
import * as z from 'zod';

interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Public origin of this Worker, e.g. https://netatmo-mcp-spike.<account>.workers.dev */
  PUBLIC_URL: string;
  /** Stub sign-in: the owner's password (Worker secret, long and random). */
  SPIKE_PASSWORD: string;
}

/** Stored, encrypted, with each grant; handed back on every authenticated request. */
interface Props {
  account: string;
}

const SCOPE = 'mcp:read';
const ACCOUNT = 'spike-owner';

// ------------------------------------------------------------------ MCP surface

function buildServer(account: string, clientId: string): McpServer {
  const server = new McpServer(
    { name: 'netatmo-mcp-spike', version: '0.0.0', title: 'Netatmo Energy (spike)' },
    {
      // ajv compiles schemas with new Function(), which Workers forbid.
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      instructions:
        'Technical test of a remote Netatmo Energy MCP server. It has no access to any heating system yet.',
    },
  );
  server.registerTool(
    'spike_whoami',
    {
      title: 'Who am I (spike)',
      description:
        'Technical test: confirms the connection works and shows which account and client the server sees. Returns no heating data.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (): Promise<CallToolResult> => {
      const data = {
        ok: true,
        account,
        client_id: clientId,
        server_time: new Date().toISOString(),
        note: 'Remote MCP spike (ADR-0013). No Netatmo access.',
      };
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    },
  );
  return server;
}

const mcp = createMcpHandler(
  (ctx) => {
    const account = ctx.authInfo?.extra?.account;
    if (typeof account !== 'string')
      throw new Error('Unauthenticated MCP request reached the server.');
    return buildServer(account, ctx.authInfo?.clientId ?? '');
  },
  { onerror: (error) => console.error('MCP error', error.message) },
);

/** Only reached with a valid access token for this resource (the provider checks it). */
const apiHandler = {
  async fetch(request: Request, _env: Env, executionCtx: ExecutionContext): Promise<Response> {
    // OAuthProvider sets props (decrypted grant data) and auth (verified token) on the context.
    const ctx = executionCtx as OAuthResourceContext<Props | undefined>;
    if (!ctx.auth.scope.includes(SCOPE) || !ctx.props) {
      return new Response('Forbidden', { status: 403 });
    }
    return mcp.fetch(request, {
      authInfo: {
        token: ctx.auth.token,
        clientId: ctx.auth.clientId ?? '',
        scopes: ctx.auth.scope,
        ...(ctx.auth.expiresAt !== undefined && { expiresAt: ctx.auth.expiresAt }),
        extra: { account: ctx.props.account },
      },
    });
  },
};

// ------------------------------------------------------------- consent and sign-in

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200, headers = new Headers()): Response {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  );
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}
input,button{font:inherit;padding:.5rem;margin:.25rem 0}input{width:100%;box-sizing:border-box}.warn{color:#a40}</style>
${body}</html>`,
    { status, headers },
  );
}

function consentPage(d: ConsentDescription, handle: string): string {
  const name = escape(d.clientName);
  const origin = d.clientDomain
    ? `Published by <strong>${escape(d.clientDomain)}</strong>.`
    : 'This app registered itself; its name is <strong>not verified</strong>.';
  return `<h1>Allow ${name} to connect?</h1>
<p>${origin} Access will be sent to <strong>${escape(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>' : ''}
<p>Scopes: ${d.scope.map(escape).join(', ') || '(none)'}. This test server has no access to any heating system.</p>
<form method="post">
<input type="hidden" name="handle" value="${escape(handle)}">
<label>Owner password<input type="password" name="password" autocomplete="current-password" required></label>
<p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny" formnovalidate>Deny</button></p>
</form>`;
}

/** Constant-time string comparison (both sides hashed to a fixed length first). */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}

async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return page(
        `Authorize ${details.clientName}`,
        consentPage(details, consent.handle),
        200,
        consent.headers,
      );
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const form = await request.formData();
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    if (
      !env.SPIKE_PASSWORD ||
      !(await sameSecret(String(form.get('password') ?? ''), env.SPIKE_PASSWORD))
    ) {
      return page('Wrong password', '<h1>Wrong password</h1><p>Go back and try again.</p>', 403);
    }
    const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: ACCOUNT,
      metadata: {},
      scope: approved.request.scope,
      props: { account: ACCOUNT } satisfies Props,
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

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/authorize') return authorize(request, env);
    if (pathname === '/') {
      return page(
        'Netatmo Energy MCP spike',
        '<h1>Netatmo Energy MCP: remote spike</h1><p>Technical test (ADR-0013). Add <code>/mcp</code> as a connector URL.</p>',
      );
    }
    return new Response('Not found', { status: 404 });
  },
};

// ------------------------------------------------------------------ provider

let provider: OAuthProvider<Env> | undefined;

function getProvider(env: Env): OAuthProvider<Env> {
  // https in production; plain http only for the local emulator (wrangler dev).
  if (!/^(https:\/\/|http:\/\/localhost(:\d+)?$)/.test(env.PUBLIC_URL ?? '')) {
    throw new Error('PUBLIC_URL must be set to the https origin.');
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
    onError: ({ code, description, status }) => console.warn('OAuth', status, code, description),
  });
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return getProvider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
