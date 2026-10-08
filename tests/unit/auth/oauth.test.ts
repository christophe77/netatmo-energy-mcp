import { describe, expect, it } from 'vitest';
import {
  AUTHORIZE_URL,
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  exchangeAuthorizationCode,
  InvalidGrantError,
  OAuthError,
  parseRedirectParams,
  parseRedirectUrl,
  parseTokenResponse,
  postTokenEndpoint,
  refreshAccessToken,
  statesMatch,
  TOKEN_URL,
} from '../../../src/auth/oauth.js';
import { NetatmoUnavailableError } from '../../../src/errors.js';
import { fakeFetch, json, tokenResponse } from '../../helpers/fake-fetch.js';

describe('state', () => {
  it('creates distinct 256-bit url-safe values', () => {
    const a = createState();
    const b = createState();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('matches only identical values and tolerates missing/short input', () => {
    const s = createState();
    expect(statesMatch(s, s)).toBe(true);
    expect(statesMatch(s, `${s}x`)).toBe(false);
    expect(statesMatch(s, s.slice(1))).toBe(false);
    expect(statesMatch(s, null)).toBe(false);
    expect(statesMatch(s, undefined)).toBe(false);
  });
});

describe('buildAuthorizeUrl', () => {
  it('requests only the read-only thermostat scope', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'cid',
        redirectUri: 'http://localhost:8977/callback',
        state: 's',
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
    expect(url.searchParams.get('scope')).toBe('read_thermostat');
    expect(url.searchParams.get('state')).toBe('s');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8977/callback');
    expect(url.searchParams.has('code_challenge')).toBe(false);
    expect(url.toString()).not.toMatch(/write_/);
  });

  it('adds an S256 challenge only when asked', () => {
    const pkce = createPkcePair();
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'c',
        redirectUri: 'http://localhost/cb',
        state: 's',
        codeChallenge: pkce.challenge,
      }),
    );
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('parseRedirectParams', () => {
  const state = 'expected-state';

  it('returns the code when state matches', () => {
    expect(parseRedirectParams(new URLSearchParams({ state, code: 'abc' }), state)).toBe('abc');
  });

  it('rejects a mismatched state before looking at anything else', () => {
    const params = new URLSearchParams({ state: 'forged', code: 'abc' });
    expect(() => parseRedirectParams(params, state)).toThrow(
      expect.objectContaining({ oauthCode: 'state_mismatch' }) as Error,
    );
    const forgedError = new URLSearchParams({ state: 'forged', error: 'access_denied' });
    expect(() => parseRedirectParams(forgedError, state)).toThrow(
      expect.objectContaining({ oauthCode: 'state_mismatch' }) as Error,
    );
  });

  it('reports access_denied and missing codes', () => {
    expect(() =>
      parseRedirectParams(new URLSearchParams({ state, error: 'access_denied' }), state),
    ).toThrow(/denied/);
    expect(() => parseRedirectParams(new URLSearchParams({ state }), state)).toThrow(
      expect.objectContaining({ oauthCode: 'missing_code' }) as Error,
    );
  });

  it('parses a pasted redirect URL', () => {
    expect(parseRedirectUrl(' http://localhost:8977/callback?state=s&code=c1 ', 's')).toBe('c1');
    expect(() => parseRedirectUrl('nope', 's')).toThrow(OAuthError);
  });
});

describe('parseTokenResponse', () => {
  const ctx = { now: 1_000_000, clientId: 'cid' };

  it('computes expiry from expires_in', () => {
    const t = parseTokenResponse(tokenResponse(1, 10800), ctx);
    expect(t).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: 1_000_000 + 10_800_000,
      obtainedAt: 1_000_000,
      scope: ['read_thermostat'],
      clientId: 'cid',
    });
  });

  it('accepts the legacy expire_in key and a space-separated scope', () => {
    const t = parseTokenResponse(
      {
        access_token: 'a',
        refresh_token: 'r',
        expire_in: 60,
        scope: 'read_thermostat read_station',
      },
      ctx,
    );
    expect(t.expiresAt).toBe(1_000_000 + 60_000);
    expect(t.scope).toEqual(['read_thermostat', 'read_station']);
  });

  it('defaults to 3 h when the lifetime is missing', () => {
    const t = parseTokenResponse({ access_token: 'a', refresh_token: 'r' }, ctx);
    expect(t.expiresAt - t.obtainedAt).toBe(10_800_000);
  });

  it('keeps the previous refresh token if none is returned', () => {
    const t = parseTokenResponse(
      { access_token: 'a', expires_in: 10 },
      { ...ctx, previousRefreshToken: 'old' },
    );
    expect(t.refreshToken).toBe('old');
  });

  it('rejects responses without an access token', () => {
    expect(() => parseTokenResponse({ refresh_token: 'r' }, ctx)).toThrow(OAuthError);
    expect(() => parseTokenResponse(null, ctx)).toThrow(OAuthError);
  });
});

describe('token endpoint', () => {
  it('sends the documented authorization_code form', async () => {
    const f = fakeFetch(() => json(tokenResponse(1)));
    const { tokens } = await exchangeAuthorizationCode(
      {
        clientId: 'cid',
        clientSecret: 'sec',
        code: 'c',
        redirectUri: 'http://localhost:8977/callback',
        now: 0,
      },
      { fetch: f },
    );
    expect(tokens.accessToken).toBe('access-1');
    const req = f.requests[0]!;
    expect(req.url.toString()).toBe(TOKEN_URL);
    expect(req.method).toBe('POST');
    expect(Object.fromEntries(req.form)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'cid',
      client_secret: 'sec',
      code: 'c',
      redirect_uri: 'http://localhost:8977/callback',
      scope: 'read_thermostat',
    });
  });

  it('sends the documented refresh_token form', async () => {
    const f = fakeFetch(() => json(tokenResponse(2)));
    const { tokens } = await refreshAccessToken(
      { clientId: 'cid', clientSecret: 'sec', refreshToken: 'refresh-1', now: 0 },
      { fetch: f },
    );
    expect(tokens.refreshToken).toBe('refresh-2');
    expect(Object.fromEntries(f.requests[0]!.form)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      client_id: 'cid',
      client_secret: 'sec',
    });
  });

  it('maps invalid_grant to InvalidGrantError', async () => {
    const f = fakeFetch(() => json({ error: 'invalid_grant' }, 400));
    await expect(postTokenEndpoint({}, { fetch: f })).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('maps the API-style code 30 envelope to InvalidGrantError', async () => {
    const f = fakeFetch(() => json({ error: { code: 30, message: 'Invalid refresh token' } }, 403));
    await expect(postTokenEndpoint({}, { fetch: f })).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('maps invalid_client with an actionable hint', async () => {
    const f = fakeFetch(() => json({ error: 'invalid_client' }, 400));
    await expect(postTokenEndpoint({}, { fetch: f })).rejects.toMatchObject({
      oauthCode: 'invalid_client',
      hint: expect.stringContaining('dev.netatmo.com') as string,
    });
  });

  it('maps 5xx and network failures to NetatmoUnavailableError', async () => {
    await expect(
      postTokenEndpoint({}, { fetch: fakeFetch(() => json({}, 503)) }),
    ).rejects.toBeInstanceOf(NetatmoUnavailableError);
    const failing = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(postTokenEndpoint({}, { fetch: failing })).rejects.toBeInstanceOf(
      NetatmoUnavailableError,
    );
  });

  it('never puts the client secret in error messages', async () => {
    const f = fakeFetch(() => json({ error: 'weird', error_description: 'nope' }, 400));
    const err = (await postTokenEndpoint({ client_secret: 'TOPSECRET' }, { fetch: f }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err.message).not.toContain('TOPSECRET');
  });
});
