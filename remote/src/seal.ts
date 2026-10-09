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
