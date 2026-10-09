/**
 * Encryption at rest for account secrets (ADR-0013 §3): AES-GCM with a 256-bit key from the
 * DATA_KEY secret. The account key is bound as additional data, so a record cannot be moved to
 * another account.
 */
import { base64UrlDecode, base64UrlEncode } from '../../src/utils/web-crypto.js';

const encoder = new TextEncoder();

export async function importDataKey(secret: string | undefined): Promise<CryptoKey> {
  const raw = secret ? base64UrlDecode(secret.trim()) : new Uint8Array();
  if (raw.length !== 32) {
    throw new Error('DATA_KEY must be 32 random bytes, base64 or base64url encoded.');
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
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
  const raw = secret ? base64UrlDecode(secret.trim()) : new Uint8Array();
  if (raw.length !== 32) throw new Error('DATA_KEY must be 32 random bytes.');
  const ikm = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  const hmacKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: encoder.encode('netatmo-energy-mcp account key v1'),
    },
    ikm,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(netatmoUserId));
  return `u_${base64UrlEncode(new Uint8Array(mac).slice(0, 18))}`;
}
