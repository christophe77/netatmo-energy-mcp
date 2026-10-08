import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, NetatmoUnavailableError } from '../errors.js';
import { USER_AGENT } from '../version.js';
import type { TokenSet } from './credential-store.js';

export const AUTHORIZE_URL = 'https://api.netatmo.com/oauth2/authorize';
export const TOKEN_URL = 'https://api.netatmo.com/oauth2/token';

/** v0.1 is read-only: this is the only scope ever requested (ADR-0002). */
export const READ_ONLY_SCOPES = ['read_thermostat'] as const;

export type FetchFn = typeof fetch;

/** OAuth protocol error from the token endpoint (RFC 6749 §5.2) or the redirect. */
export class OAuthError extends AppError {
  override name = 'OAuthError';
  constructor(
    readonly oauthCode: string,
    message: string,
    options: { hint?: string; cause?: unknown } = {},
  ) {
    super('AUTH_REQUIRED', message, options);
  }
}

/** The refresh token (or authorization code) is invalid, expired, revoked or already used. */
export class InvalidGrantError extends OAuthError {
  override name = 'InvalidGrantError';
}

export function createState(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time comparison of OAuth `state` values. */
export function statesMatch(expected: string, received: string | null | undefined): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256 pair. Netatmo does not document PKCE; only used with --experimental-pkce. */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface AuthorizeUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
  codeChallenge?: string;
}

export function buildAuthorizeUrl(p: AuthorizeUrlParams): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('scope', (p.scopes ?? READ_ONLY_SCOPES).join(' '));
  url.searchParams.set('state', p.state);
  if (p.codeChallenge) {
    url.searchParams.set('code_challenge', p.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

/**
 * Validate the parameters of the OAuth redirect and extract the authorization code.
 * The state is checked before anything else, so an error from a forged request is never trusted.
 */
export function parseRedirectParams(params: URLSearchParams, expectedState: string): string {
  if (!statesMatch(expectedState, params.get('state'))) {
    throw new OAuthError(
      'state_mismatch',
      'The OAuth state parameter did not match. The login attempt was rejected for safety.',
      { hint: 'Start a new login and use the most recent authorization link.' },
    );
  }
  const error = params.get('error');
  if (error) {
    const message =
      error === 'access_denied'
        ? 'Access was denied on the Netatmo authorization page.'
        : `Netatmo returned an authorization error: ${error}`;
    throw new OAuthError(error, message);
  }
  const code = params.get('code');
  if (!code)
    throw new OAuthError('missing_code', 'The redirect did not contain an authorization code.');
  return code;
}

/** For `login --manual`: the user pastes the full URL their browser was redirected to. */
export function parseRedirectUrl(
  pasted: string,
  expectedState: string,
  redirectUri?: string,
): string {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    throw new OAuthError('invalid_redirect', 'That does not look like a URL.');
  }
  if (redirectUri) {
    const expected = new URL(redirectUri);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
      throw new OAuthError(
        'invalid_redirect',
        `The pasted URL does not start with the redirect URI ${expected.origin}${expected.pathname}.`,
      );
    }
  }
  return parseRedirectParams(url.searchParams, expectedState);
}

/** Parse a token endpoint success response. Accepts the legacy `expire_in` key too. */
export function parseTokenResponse(
  json: unknown,
  ctx: { now: number; clientId: string; previousRefreshToken?: string },
): TokenSet {
  if (json === null || typeof json !== 'object') {
    throw new OAuthError(
      'invalid_response',
      'The Netatmo token endpoint returned an invalid response.',
    );
  }
  const body = json as Record<string, unknown>;
  const accessToken = body.access_token;
  const refreshToken = body.refresh_token ?? ctx.previousRefreshToken;
  const expiresIn = Number(body.expires_in ?? body.expire_in);
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new OAuthError('invalid_response', 'The token response did not contain an access token.');
  }
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    throw new OAuthError('invalid_response', 'The token response did not contain a refresh token.');
  }
  const scope = Array.isArray(body.scope)
    ? body.scope.filter((s): s is string => typeof s === 'string')
    : typeof body.scope === 'string'
      ? body.scope.split(/[\s,]+/).filter(Boolean)
      : [];
  return {
    accessToken,
    refreshToken,
    // Default to Netatmo's documented 3 h if the lifetime is missing or malformed.
    expiresAt: ctx.now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 10_800) * 1000,
    obtainedAt: ctx.now,
    scope,
    clientId: ctx.clientId,
  };
}

/** Shape-only description of a token response, for `probe`. Never includes values. */
export function describeTokenResponseShape(json: unknown): Record<string, string> {
  if (json === null || typeof json !== 'object') return {};
  return Object.fromEntries(
    Object.entries(json).map(([k, v]) => [k, Array.isArray(v) ? 'array' : typeof v]),
  );
}

export interface TokenEndpointOptions {
  fetch?: FetchFn;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** POST to the token endpoint. Not retried automatically: a refresh is not idempotent. */
export async function postTokenEndpoint(
  form: Record<string, string>,
  opts: TokenEndpointOptions = {},
): Promise<unknown> {
  const doFetch = opts.fetch ?? fetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams(form).toString(),
      signal,
    });
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    throw new NetatmoUnavailableError('Could not reach the Netatmo token endpoint.', {
      cause: error,
    });
  }

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }

  if (res.ok) return json;

  if (res.status >= 500) {
    throw new NetatmoUnavailableError(`The Netatmo token endpoint returned HTTP ${res.status}.`);
  }
  const { code, description } = extractOAuthError(json);
  if (code === 'invalid_grant') {
    throw new InvalidGrantError(
      code,
      'Netatmo rejected the authorization grant (expired, revoked or already used).',
      { hint: 'Run "netatmo-energy-mcp login" to authorize access again.' },
    );
  }
  if (code === 'invalid_client' || code === 'unauthorized_client') {
    throw new OAuthError(code, 'Netatmo rejected the client ID or client secret.', {
      hint: 'Check the credentials of your app at https://dev.netatmo.com/apps and run "netatmo-energy-mcp login" again.',
    });
  }
  if (code === 'redirect_uri_mismatch') {
    throw new OAuthError(
      code,
      'The redirect URI does not match the one registered in your Netatmo app.',
      {
        hint: 'Register the exact redirect URI shown by "login" in your app settings, or set NETATMO_REDIRECT_URI.',
      },
    );
  }
  throw new OAuthError(
    code ?? `http_${res.status}`,
    `The Netatmo token endpoint returned HTTP ${res.status}${description ? `: ${description}` : ''}.`,
  );
}

function extractOAuthError(json: unknown): { code?: string; description?: string } {
  if (json === null || typeof json !== 'object') return {};
  const body = json as Record<string, unknown>;
  if (typeof body.error === 'string') {
    const description =
      typeof body.error_description === 'string' ? body.error_description : undefined;
    return description === undefined ? { code: body.error } : { code: body.error, description };
  }
  // Netatmo API-style error envelope: { error: { code, message } }
  if (body.error && typeof body.error === 'object') {
    const e = body.error as Record<string, unknown>;
    const code = typeof e.code === 'number' && e.code === 30 ? 'invalid_grant' : undefined;
    const description = typeof e.message === 'string' ? e.message : undefined;
    return { ...(code && { code }), ...(description && { description }) };
  }
  return {};
}

export interface ExchangeCodeParams {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  scopes?: readonly string[];
  codeVerifier?: string;
  now: number;
}

export async function exchangeAuthorizationCode(
  p: ExchangeCodeParams,
  opts: TokenEndpointOptions = {},
): Promise<{ tokens: TokenSet; raw: unknown }> {
  const form: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: p.clientId,
    client_secret: p.clientSecret,
    code: p.code,
    redirect_uri: p.redirectUri,
    scope: (p.scopes ?? READ_ONLY_SCOPES).join(' '),
  };
  if (p.codeVerifier) form.code_verifier = p.codeVerifier;
  const raw = await postTokenEndpoint(form, opts);
  return { tokens: parseTokenResponse(raw, { now: p.now, clientId: p.clientId }), raw };
}

export interface RefreshParams {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  now: number;
}

export async function refreshAccessToken(
  p: RefreshParams,
  opts: TokenEndpointOptions = {},
): Promise<{ tokens: TokenSet; raw: unknown }> {
  const raw = await postTokenEndpoint(
    {
      grant_type: 'refresh_token',
      refresh_token: p.refreshToken,
      client_id: p.clientId,
      client_secret: p.clientSecret,
    },
    opts,
  );
  return {
    tokens: parseTokenResponse(raw, {
      now: p.now,
      clientId: p.clientId,
      previousRefreshToken: p.refreshToken,
    }),
    raw,
  };
}
