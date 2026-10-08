/**
 * Application error hierarchy. Each error carries a stable `code` that MCP tools
 * surface to the assistant (ADR-0008) and an optional actionable `hint`.
 * Messages must never contain tokens or secrets.
 */

export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED_CAPABILITY'
  | 'NETATMO_UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'CONFIG_ERROR';

export interface AppErrorOptions {
  hint?: string;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.hint = options.hint;
  }
}

const LOGIN_HINT = 'Run "netatmo-energy-mcp login" to authorize access again.';

export class AuthRequiredError extends AppError {
  override name = 'AuthRequiredError';
  constructor(message: string, options: AppErrorOptions = {}) {
    super('AUTH_REQUIRED', message, { hint: LOGIN_HINT, ...options });
  }
}

export class PermissionDeniedError extends AppError {
  override name = 'PermissionDeniedError';
  constructor(message: string, options: AppErrorOptions = {}) {
    super('PERMISSION_DENIED', message, { hint: LOGIN_HINT, ...options });
  }
}

export class RateLimitError extends AppError {
  override name = 'RateLimitError';
  /** Suggested wait before retrying, when known. */
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number, options: AppErrorOptions = {}) {
    const hint =
      retryAfterMs === undefined
        ? 'Wait a few minutes before retrying, or request less data (coarser scale, shorter range).'
        : `Retry in about ${Math.ceil(retryAfterMs / 1000)} s.`;
    super('RATE_LIMITED', message, { hint, ...options });
    this.retryAfterMs = retryAfterMs;
  }
}

export class NotFoundError extends AppError {
  override name = 'NotFoundError';
  constructor(message: string, options: AppErrorOptions = {}) {
    super('NOT_FOUND', message, options);
  }
}

export class InvalidArgumentError extends AppError {
  override name = 'InvalidArgumentError';
  constructor(message: string, options: AppErrorOptions = {}) {
    super('INVALID_ARGUMENT', message, options);
  }
}

export class UnsupportedCapabilityError extends AppError {
  override name = 'UnsupportedCapabilityError';
  constructor(message: string, options: AppErrorOptions = {}) {
    super('UNSUPPORTED_CAPABILITY', message, options);
  }
}

export class NetatmoUnavailableError extends AppError {
  override name = 'NetatmoUnavailableError';
  constructor(message: string, options: AppErrorOptions = {}) {
    super('NETATMO_UNAVAILABLE', message, {
      hint: 'The Netatmo API could not be reached or returned a server error. Try again later.',
      ...options,
    });
  }
}

export class InvalidResponseError extends AppError {
  override name = 'InvalidResponseError';
  constructor(message: string, options: AppErrorOptions = {}) {
    super('INVALID_RESPONSE', message, {
      hint: 'Netatmo returned data in an unexpected format. Please report it with "netatmo-energy-mcp probe --sanitize".',
      ...options,
    });
  }
}
