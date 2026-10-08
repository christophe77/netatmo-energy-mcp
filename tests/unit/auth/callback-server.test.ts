import { describe, expect, it } from 'vitest';
import {
  parseLoopbackRedirectUri,
  startCallbackServer,
} from '../../../src/auth/callback-server.js';
import { OAuthError } from '../../../src/auth/oauth.js';

const STATE = 'state-123';

async function start(timeoutMs = 5_000) {
  return startCallbackServer({
    redirectUri: 'http://127.0.0.1:8977/callback',
    expectedState: STATE,
    port: 0,
    timeoutMs,
  });
}

describe('parseLoopbackRedirectUri', () => {
  it('accepts loopback http URIs', () => {
    expect(parseLoopbackRedirectUri('http://localhost:8977/callback')).toEqual({
      hosts: ['127.0.0.1', '::1'],
      port: 8977,
      pathname: '/callback',
    });
    expect(parseLoopbackRedirectUri('http://127.0.0.1:9000/cb').hosts).toEqual(['127.0.0.1']);
  });

  it('rejects non-local or https URIs', () => {
    expect(() => parseLoopbackRedirectUri('https://example.com/cb')).toThrow(OAuthError);
    expect(() => parseLoopbackRedirectUri('http://192.168.1.2:8977/cb')).toThrow(OAuthError);
  });
});

describe('startCallbackServer', () => {
  it('ignores forged state and resolves on the genuine redirect', async () => {
    const server = await start();
    const base = `http://127.0.0.1:${server.port}`;

    const forged = await fetch(`${base}/callback?state=wrong&code=evil`);
    expect(forged.status).toBe(400);
    expect(forged.headers.get('referrer-policy')).toBe('no-referrer');

    const other = await fetch(`${base}/other?state=${STATE}&code=x`);
    expect(other.status).toBe(404);

    const ok = await fetch(`${base}/callback?state=${STATE}&code=good`);
    expect(ok.status).toBe(200);
    expect(await server.code).toBe('good');
  });

  it('rejects when the user denies access', async () => {
    const server = await start();
    await fetch(`http://127.0.0.1:${server.port}/callback?state=${STATE}&error=access_denied`);
    await expect(server.code).rejects.toThrow(/denied/);
  });

  it('times out', async () => {
    const server = await start(50);
    await expect(server.code).rejects.toMatchObject({ oauthCode: 'timeout' });
  });

  it('stops listening after completion', async () => {
    const server = await start();
    const base = `http://127.0.0.1:${server.port}`;
    await fetch(`${base}/callback?state=${STATE}&code=c`);
    await server.code;
    await server.close();
    await expect(fetch(`${base}/callback`)).rejects.toThrow();
  });
});
