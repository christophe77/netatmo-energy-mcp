import type { AppError } from '../errors.js';
import {
  AuthRequiredError,
  InvalidArgumentError,
  NetatmoUnavailableError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from '../errors.js';

export interface ClassifiedError {
  error: AppError;
  /** Safe to retry the same read request after a delay. */
  retryable: boolean;
  /** The access token was rejected; refresh once and retry. */
  tokenRejected: boolean;
  retryAfterMs?: number;
}

/** Parse a Retry-After header (delta-seconds or HTTP-date). */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export function extractApiError(json: unknown): { code?: number; message?: string } {
  if (json === null || typeof json !== 'object') return {};
  const err = (json as { error?: unknown }).error;
  if (err && typeof err === 'object') {
    const { code, message } = err as { code?: unknown; message?: unknown };
    return {
      ...(typeof code === 'number' && { code }),
      ...(typeof message === 'string' && { message }),
    };
  }
  return {};
}

/**
 * Map a failed Netatmo API response to an application error.
 * Codes from https://dev.netatmo.com/apidocumentation/general (see docs/api-capabilities.md §8),
 * plus code 11 (concurrency) observed by pyatmo.
 */
export function classifyApiError(
  status: number,
  json: unknown,
  retryAfterHeader: string | null,
  now: number,
): ClassifiedError {
  const { code, message } = extractApiError(json);
  const retryAfterMs = parseRetryAfter(retryAfterHeader, now);
  const detail = `HTTP ${status}${code === undefined ? '' : `, Netatmo error ${code}`}${message ? `: ${message}` : ''}`;
  const base = { retryable: false, tokenRejected: false };
  const withRetry = retryAfterMs === undefined ? {} : { retryAfterMs };

  if (code === 2 || code === 3 || (status === 401 && code === undefined)) {
    return {
      ...base,
      tokenRejected: true,
      error: new AuthRequiredError(`Netatmo rejected the access token (${detail}).`),
    };
  }
  if (code === 13) {
    return {
      ...base,
      error: new PermissionDeniedError(
        `Netatmo refused the operation; the token probably lacks the read_thermostat scope (${detail}).`,
      ),
    };
  }
  if (code === 5) {
    return {
      ...base,
      error: new AuthRequiredError(`Your Netatmo app is deactivated (${detail}).`, {
        hint: 'Check your app at https://dev.netatmo.com/apps.',
      }),
    };
  }
  if (code === 26 || code === 28 || code === 29 || status === 429) {
    // Code 26 ("usage reached") is usually an hourly quota; only retry it on a short Retry-After.
    const retryable = code === 26 ? retryAfterMs !== undefined && retryAfterMs <= 60_000 : true;
    return {
      ...base,
      ...withRetry,
      retryable: retryable && (retryAfterMs === undefined || retryAfterMs <= 60_000),
      error: new RateLimitError(`Netatmo rate limit reached (${detail}).`, retryAfterMs),
    };
  }
  if (code === 11) {
    return {
      ...base,
      ...withRetry,
      retryable: true,
      error: new NetatmoUnavailableError(`Netatmo reported concurrent requests (${detail}).`),
    };
  }
  if (code === 9 || code === 19 || code === 23 || status === 404) {
    return { ...base, error: new NotFoundError(`Not found on Netatmo (${detail}).`) };
  }
  if (code === 10 || code === 21 || code === 25 || status === 400) {
    return {
      ...base,
      error: new InvalidArgumentError(`Netatmo rejected the request parameters (${detail}).`),
    };
  }
  if (status >= 500) {
    return {
      ...base,
      ...withRetry,
      retryable: true,
      error: new NetatmoUnavailableError(`Netatmo API error (${detail}).`),
    };
  }
  return {
    ...base,
    error: new NetatmoUnavailableError(`Unexpected Netatmo API error (${detail}).`),
  };
}
