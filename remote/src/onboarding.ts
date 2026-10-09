/**
 * Onboarding (ADR-0014 §3): someone connects their own Netatmo app from the consent page.
 *
 * POST /authorize (decision=onboard) → consent approved → beginUpstream() stores the app
 * credentials encrypted, bound to this browser → redirect to Netatmo → GET /netatmo/callback →
 * finishUpstream() → code exchange → homesdata (Netatmo user ID) → account key → the account's
 * Durable Object stores the link → MCP authorization completed for that account only.
 */
import { authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  READ_ONLY_SCOPES,
  READ_WRITE_SCOPES,
} from '../../src/auth/oauth.js';
import { AppError } from '../../src/errors.js';
import { NetatmoClient } from '../../src/netatmo/client.js';
import { randomToken, sha256Base64Url } from '../../src/utils/web-crypto.js';
import type { Env } from './env.js';
import { netatmoFetch } from './netatmo-fetch.js';
import { escape, page } from './pages.js';
import { accountKeyFor } from './seal.js';

export type OnboardingMode = 'off' | 'invite' | 'open';

export function onboardingMode(env: Env): OnboardingMode {
  const mode = env.ONBOARDING ?? 'off';
  if (mode !== 'off' && mode !== 'invite' && mode !== 'open') {
    throw new Error('ONBOARDING must be off, invite or open.');
  }
  return mode;
}

export const callbackUrl = (env: Env): string =>
  `${env.PUBLIC_URL.replace(/\/+$/, '')}/netatmo/callback`;

/** What beginUpstream() keeps (encrypted by the library) until Netatmo calls back. */
interface PendingOnboarding {
  clientId: string;
  clientSecret: string;
  write: boolean;
  inviteHash?: string;
}

const INVITE_TTL_S = 7 * 86_400;
const inviteKey = (hash: string) => `invite:${hash}`;

/** Single-use invite code for ONBOARDING=invite, valid 7 days. Only its hash is stored. */
export async function createInvite(env: Env): Promise<{ code: string; expires_at: string }> {
  const code = randomToken(12);
  await env.OAUTH_KV.put(inviteKey(await sha256Base64Url(code)), '1', {
    expirationTtl: INVITE_TTL_S,
  });
  return { code, expires_at: new Date(Date.now() + INVITE_TTL_S * 1000).toISOString() };
}

const fail = (title: string, message: string, status = 400) =>
  page(title, `<h1>${escape(title)}</h1><p>${escape(message)}</p>`, status);

/** POST /authorize with decision=onboard: approve consent, then go to Netatmo. */
export async function startOnboarding(
  request: Request,
  env: Env,
  form: FormData,
  handle: string,
  scope: string,
): Promise<Response> {
  const mode = onboardingMode(env);
  if (mode === 'off')
    return fail('Not available', 'This server does not accept new accounts.', 403);

  const clientId = String(form.get('client_id') ?? '').trim();
  const clientSecret = String(form.get('client_secret') ?? '').trim();
  if (!/^[\w.-]{8,128}$/.test(clientId) || !/^[\x21-\x7e]{8,256}$/.test(clientSecret)) {
    return fail(
      'Invalid app credentials',
      'Copy the client ID and client secret of your Netatmo app exactly.',
    );
  }
  let inviteHash: string | undefined;
  if (mode === 'invite') {
    inviteHash = await sha256Base64Url(String(form.get('invite') ?? '').trim());
    if (!(await env.OAUTH_KV.get(inviteKey(inviteHash)))) {
      return fail('Invalid invite', 'This invite code is unknown, expired or already used.', 403);
    }
  }
  const write = form.get('write') === 'on';

  const oauth = env.OAUTH_PROVIDER;
  const approved = await oauth.approveConsent(request, handle, { scope: [scope] });
  const pending: PendingOnboarding = {
    clientId,
    clientSecret,
    write,
    ...(inviteHash && { inviteHash }),
  };
  const { state, headers } = await oauth.beginUpstream(approved.request, {
    data: pending,
    headers: approved.headers,
  });
  headers.set(
    'Location',
    buildAuthorizeUrl({
      clientId,
      redirectUri: callbackUrl(env),
      state,
      scopes: write ? READ_WRITE_SCOPES : READ_ONLY_SCOPES,
    }),
  );
  return new Response(null, { status: 302, headers });
}

/** GET /netatmo/callback: Netatmo sends the user back with a code (or an error). */
export async function netatmoCallback(
  request: Request,
  env: Env,
  scope: string,
): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  // Throws AuthorizationError (rendered by the caller) if state is unknown, used or unbound.
  const {
    request: original,
    data,
    headers,
  } = await oauth.finishUpstream<PendingOnboarding>(request);
  const params = new URL(request.url).searchParams;
  const redirectWithError = (
    description: string,
    code: 'access_denied' | 'server_error' = 'server_error',
  ) => {
    headers.set('Location', authorizationErrorRedirect(original, code, description));
    return new Response(null, { status: 302, headers });
  };
  const code = params.get('code');
  if (params.get('error') || !code)
    return redirectWithError('Netatmo access was not granted.', 'access_denied');

  const fetchFn = netatmoFetch(env.NETATMO_API_BASE);
  try {
    const { tokens } = await exchangeAuthorizationCode(
      {
        clientId: data.clientId,
        clientSecret: data.clientSecret,
        code,
        redirectUri: callbackUrl(env),
        scopes: data.write ? READ_WRITE_SCOPES : READ_ONLY_SCOPES,
        now: Date.now(),
      },
      { fetch: fetchFn },
    );
    // The Netatmo user ID identifies the account; it is only used to derive the account key.
    const probe = new NetatmoClient({
      fetch: fetchFn,
      tokens: {
        getAccessToken: () => Promise.resolve(tokens.accessToken),
        handleRejectedToken: () => Promise.reject(new Error('Netatmo rejected the new token.')),
      },
    });
    const userId = (await probe.homesData()).body.user as { id?: unknown } | undefined;
    if (typeof userId?.id !== 'string' || userId.id === '') {
      return redirectWithError('Netatmo did not identify the account.');
    }
    if (data.inviteHash) {
      const key = inviteKey(data.inviteHash);
      if (!(await env.OAUTH_KV.get(key)))
        return redirectWithError('The invite code was already used.', 'access_denied');
      await env.OAUTH_KV.delete(key);
    }
    const account = await accountKeyFor(env.DATA_KEY, userId.id);
    await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(account)).setup({
      clientId: data.clientId,
      clientSecret: data.clientSecret,
      tokens,
    });
    const { redirectTo } = await oauth.completeAuthorization({
      request: original,
      userId: account,
      metadata: {},
      scope: original.scope.includes(scope) ? original.scope : [scope],
      props: { account },
    });
    headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    console.warn('Onboarding failed', error instanceof AppError ? error.code : 'unexpected');
    return redirectWithError(
      'Could not link the Netatmo account. Check the app credentials and its redirect URI.',
    );
  }
}
