import type { FetchFn } from '../../src/auth/oauth.js';

/**
 * `fetch` for Netatmo. NETATMO_API_BASE redirects api.netatmo.com to a local fake for tests; it
 * is honoured only for loopback addresses, so a misconfiguration cannot send tokens elsewhere.
 */
export function netatmoFetch(base: string | undefined): FetchFn {
  if (!base) return (input, init) => fetch(input, init);
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
    throw new Error('NETATMO_API_BASE may only point to a loopback address (tests).');
  }
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // Anchored on the path separator, so api.netatmo.com.example is never rewritten.
    return fetch(url.replace(/^https:\/\/api\.netatmo\.com(?=\/)/, base), init);
  };
}
