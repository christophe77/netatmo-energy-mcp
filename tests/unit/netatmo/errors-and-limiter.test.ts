import { describe, expect, it } from 'vitest';
import { classifyApiError, parseRetryAfter } from '../../../src/netatmo/errors.js';
import { RateLimiter } from '../../../src/netatmo/rate-limiter.js';
import { RateLimitError } from '../../../src/errors.js';
import { fakeClock } from '../../helpers/fakes.js';

const err = (code: number, message = 'x') => ({ error: { code, message } });

describe('classifyApiError', () => {
  it.each([
    [403, err(2), 'AUTH_REQUIRED', { tokenRejected: true, retryable: false }],
    [403, err(3), 'AUTH_REQUIRED', { tokenRejected: true, retryable: false }],
    [401, undefined, 'AUTH_REQUIRED', { tokenRejected: true, retryable: false }],
    [403, err(13), 'PERMISSION_DENIED', { tokenRejected: false, retryable: false }],
    [406, err(5), 'AUTH_REQUIRED', { tokenRejected: false, retryable: false }],
    [429, err(28), 'RATE_LIMITED', { tokenRejected: false, retryable: true }],
    [429, err(26), 'RATE_LIMITED', { tokenRejected: false, retryable: false }],
    [403, err(26), 'RATE_LIMITED', { tokenRejected: false, retryable: false }],
    [429, err(11), 'RATE_LIMITED', { tokenRejected: false, retryable: true }],
    [404, err(9), 'NOT_FOUND', { tokenRejected: false, retryable: false }],
    [400, err(21), 'INVALID_ARGUMENT', { tokenRejected: false, retryable: false }],
    [400, err(25), 'INVALID_ARGUMENT', { tokenRejected: false, retryable: false }],
    [503, undefined, 'NETATMO_UNAVAILABLE', { tokenRejected: false, retryable: true }],
    [500, err(40), 'NETATMO_UNAVAILABLE', { tokenRejected: false, retryable: true }],
  ])('HTTP %i %j → %s', (status, json, code, flags) => {
    const c = classifyApiError(status, json, null, 0);
    expect(c.error.code).toBe(code);
    expect({ tokenRejected: c.tokenRejected, retryable: c.retryable }).toEqual(flags);
  });

  it('retries a usage-limit error only with a short Retry-After', () => {
    expect(classifyApiError(403, err(26), '5', 0)).toMatchObject({
      retryable: true,
      retryAfterMs: 5000,
    });
    expect(classifyApiError(429, err(28), '600', 0)).toMatchObject({ retryable: false });
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('7', 0)).toBe(7000);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 0)).toBe(10_000);
    expect(parseRetryAfter('soon', 0)).toBeUndefined();
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });
});

describe('RateLimiter', () => {
  it('allows bursts up to the window limit, then waits', async () => {
    const clock = fakeClock(0);
    const rl = new RateLimiter({ clock, windows: [{ limit: 3, windowMs: 10_000 }] });
    for (let i = 0; i < 3; i++) await rl.acquire();
    expect(clock.sleeps).toEqual([]);
    await rl.acquire();
    expect(clock.sleeps).toEqual([10_000]);
  });

  it('enforces every window', async () => {
    const clock = fakeClock(0);
    const rl = new RateLimiter({
      clock,
      windows: [
        { limit: 2, windowMs: 1_000 },
        { limit: 3, windowMs: 60_000 },
      ],
      maxWaitMs: 120_000,
    });
    await rl.acquire();
    await rl.acquire();
    await rl.acquire(); // waits for the 1 s window
    expect(clock.now()).toBe(1_000);
    await rl.acquire(); // now the 60 s window is full
    expect(clock.now()).toBe(60_000);
  });

  it('fails fast instead of waiting longer than maxWaitMs', async () => {
    const clock = fakeClock(0);
    const rl = new RateLimiter({
      clock,
      windows: [{ limit: 1, windowMs: 3_600_000 }],
      maxWaitMs: 30_000,
    });
    await rl.acquire();
    await expect(rl.acquire()).rejects.toBeInstanceOf(RateLimitError);
    // A failed caller does not block later ones once time passes.
    clock.advance(3_600_000);
    await expect(rl.acquire()).resolves.toBeUndefined();
  });
});
