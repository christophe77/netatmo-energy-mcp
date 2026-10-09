/**
 * Encryption at rest for account secrets (ADR-0013 §3): AES-GCM with a 256-bit key derived
 * from the DATA_KEY secret (HKDF). The account key is bound as additional data, so a record cannot be moved to
 * another account.
 */
import { base64UrlDecode, base64UrlEncode } from '../../src/utils/web-crypto.js';

const encoder = new TextEncoder();

/** HKDF input key from DATA_KEY (32 random bytes, base64 or base64url). */
async function masterKey(secret: string | undefined): Promise<CryptoKey> {
  const raw = secret ? base64UrlDecode(secret.trim()) : new Uint8Array();
  if (raw.length !== 32) {
    throw new Error('DATA_KEY must be 32 random bytes, base64 or base64url encoded.');
  }
  return crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
}

/** Separate keys per purpose, all derived from DATA_KEY with HKDF (no key is used twice). */
const hkdf = (info: string) => ({
  name: 'HKDF',
  hash: 'SHA-256',
  salt: new Uint8Array(),
  info: encoder.encode(`netatmo-energy-mcp ${info}`),
});

export async function importDataKey(secret: string | undefined): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    hkdf('seal v1'),
    await masterKey(secret),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(key: CryptoKey, value: unknown, boundTo: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(boundTo) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

export async function unseal<T>(key: CryptoKey, sealed: string, boundTo: string): Promise<T> {
  const [version, iv, ciphertext] = sealed.split('.');
  if (version !== 'v1' || !iv || !ciphertext) throw new Error('Unknown sealed record format.');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlDecode(iv), additionalData: encoder.encode(boundTo) },
    key,
    base64UrlDecode(ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/**
 * Stable, opaque account key for an onboarded Netatmo user (ADR-0014 §3): HMAC-SHA256 of the
 * Netatmo user ID under a key derived from DATA_KEY (HKDF), so the raw ID is never stored and
 * the AES key is not reused for another purpose.
 */
export async function accountKeyFor(
  secret: string | undefined,
  netatmoUserId: string,
): Promise<string> {
  const hmacKey = await crypto.subtle.deriveKey(
    hkdf('account key v1'),
    await masterKey(secret),
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(netatmoUserId));
  return `u_${base64UrlEncode(new Uint8Array(mac).slice(0, 18))}`;
}
