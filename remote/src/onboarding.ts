/**
 * Onboarding (ADR-0014 §3): someone connects their own Netatmo app from the consent page.
 *
 * POST /authorize (decision=onboard) → consent approved → beginUpstream() stores the app
 * credentials encrypted, bound to this browser → redirect to Netatmo → GET /netatmo/callback →
 * finishUpstream() → code exchange → homesdata (Netatmo user ID) → account key → the account's
 * Durable Object stores the link → MCP authorization completed for that account only.
 */
import {
  authorizationErrorRedirect,
  type ApprovedConsent,
} from '@cloudflare/workers-oauth-provider';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  READ_ONLY_SCOPES,
  READ_WRITE_SCOPES,
} from '../../src/auth/oauth.js';
import { AppError } from '../../src/errors.js';
import { NetatmoClient } from '../../src/netatmo/client.js';
import { randomToken, sha256Base64Url } from '../../src/utils/web-crypto.js';
import { publicOrigin, type Env } from './env.js';
import { netatmoFetch } from './netatmo-fetch.js';
import { escape, page } from './pages.js';
import { guard } from './guard.js';
import { accountKeyFor } from './seal.js';

/** Account key of the pre-configured owner (ADR-0014 §2). */
export const OWNER_ACCOUNT = 'owner';

export type OnboardingMode = 'off' | 'invite' | 'open';

export function onboardingMode(env: Env): OnboardingMode {
  const mode = env.ONBOARDING ?? 'off';
  if (mode !== 'off' && mode !== 'invite' && mode !== 'open') {
    throw new Error('ONBOARDING must be off, invite or open.');
  }
  return mode;
}

export const callbackUrl = (env: Env): string => `${publicOrigin(env)}/netatmo/callback`;

/** What beginUpstream() keeps (encrypted by the library) until Netatmo calls back. */
interface PendingOnboarding {
  clientId: string;
  clientSecret: string;
  write: boolean;
  inviteHash?: string;
}

const INVITE_TTL_MS = 7 * 86_400_000;
const DEFAULT_MAX_ACCOUNTS = 20;

/** Single-use invite code for ONBOARDING=invite, valid 7 days. Only its hash is stored. */
export async function createInvite(env: Env): Promise<{ code: string; expires_at: string }> {
  const code = randomToken(12);
  await guard(env).addInvite(await sha256Base64Url(code), INVITE_TTL_MS);
  return { code, expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString() };
}

const fail = (title: string, message: string, status = 400) =>
  page(title, `<h1>${escape(title)}</h1><p>${escape(message)}</p>`, status);

/**
 * POST /authorize with decision=onboard, after the consent was approved: check the form, then
 * go to Netatmo. The app credentials travel only inside the library's encrypted upstream record.
 * A form error is returned as `{ error }` so the caller can show the consent page again.
 */
export async function startOnboarding(
  env: Env,
  form: FormData,
  approved: ApprovedConsent,
): Promise<Response | { error: string }> {
  const mode = onboardingMode(env);
  if (mode === 'off') {
    return fail('Not available', 'This server does not accept new accounts.', 403);
  }
  const clientId = String(form.get('client_id') ?? '').trim();
  const clientSecret = String(form.get('client_secret') ?? '').trim();
  // Printable ASCII without spaces: what Netatmo issues; anything else is a copy mistake.
  if (!/^[\w.-]{8,128}$/.test(clientId) || !/^[!-~]{8,256}$/.test(clientSecret)) {
    return { error: 'Copy the client ID and client secret of your Netatmo app exactly.' };
  }
  let inviteHash: string | undefined;
  if (mode === 'invite') {
    inviteHash = await sha256Base64Url(String(form.get('invite') ?? '').trim());
    if (!(await guard(env).hasInvite(inviteHash))) {
      return { error: 'This invite code is unknown, expired or already used.' };
    }
  }
  const write = form.get('write') === 'on';
  const pending: PendingOnboarding = {
    clientId,
    clientSecret,
    write,
    ...(inviteHash && { inviteHash }),
  };
  const { state, headers } = await env.OAUTH_PROVIDER.beginUpstream(approved.request, {
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
  if (params.get('error') || !code) {
    return redirectWithError('Netatmo access was not granted.', 'access_denied');
  }

  const fetchFn = netatmoFetch(env.NETATMO_API_BASE);
  const g = guard(env);
  let consumedInvite: number | undefined;
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
    const user = (await probe.homesData()).body.user as { id?: unknown } | undefined;
    if (typeof user?.id !== 'string' || user.id === '') {
      return redirectWithError('Netatmo did not identify the account.');
    }
    const account = await accountKeyFor(env.DATA_KEY, user.id);
    const known = (await g.accounts()).some((a) => a.key === account);
    if (!known) {
      const max = Number(env.MAX_ACCOUNTS ?? DEFAULT_MAX_ACCOUNTS);
      const onboarded = (await g.accounts()).filter((a) => a.key !== OWNER_ACCOUNT).length;
      if (onboarded >= max) return redirectWithError('This server has no room for new accounts.');
    }
    if (data.inviteHash) {
      // Atomic: two flows can never both use one invite. Restored below if linking fails.
      consumedInvite = await g.consumeInvite(data.inviteHash);
      if (consumedInvite === undefined) {
        return redirectWithError('The invite code was already used.', 'access_denied');
      }
    }
    await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(account)).setup({
      clientId: data.clientId,
      clientSecret: data.clientSecret,
      tokens,
    });
    consumedInvite = undefined;
    await g.registerAccount(account);
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
    if (data.inviteHash && consumedInvite !== undefined) {
      await g.restoreInvite(data.inviteHash, consumedInvite);
    }
    console.warn('Onboarding failed', error instanceof AppError ? error.code : 'unexpected');
    return redirectWithError(
      'Could not link the Netatmo account. Check the app credentials and its redirect URI.',
    );
  }
}
