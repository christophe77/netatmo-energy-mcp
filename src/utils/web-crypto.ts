/**
 * Small crypto helpers on the Web Crypto API, available in Node.js (>= 20) and Cloudflare
 * Workers alike, so the shared core needs no `node:crypto` (ADR-0014).
 */

const encoder = new TextEncoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** `bytes` cryptographically random bytes, base64url-encoded. */
export function randomToken(bytes: number): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** SHA-256 of a UTF-8 string, base64url-encoded. */
export async function sha256Base64Url(text: string): Promise<string> {
  return base64UrlEncode(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))),
  );
}

/**
 * Constant-time comparison of two strings (UTF-8). The length is not hidden: callers compare
 * values of a known, fixed length (tokens, states).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
