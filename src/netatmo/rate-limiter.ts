import { RateLimitError } from '../errors.js';
import { systemClock, type Clock } from '../utils/clock.js';

export interface RateWindow {
  limit: number;
  windowMs: number;
}

/**
 * Default budget: 80 % of Netatmo's documented per-user limits
 * (50 requests / 10 s and 500 requests / hour). See ADR-0007.
 */
export const DEFAULT_RATE_WINDOWS: readonly RateWindow[] = [
  { limit: 40, windowMs: 10_000 },
  { limit: 400, windowMs: 3_600_000 },
];

export interface RateLimiterOptions {
  windows?: readonly RateWindow[];
  clock?: Clock;
  /** Fail fast instead of waiting longer than this for a slot. */
  maxWaitMs?: number;
}

/** Client-side sliding-window limiter. Shared by every request a process makes. */
export class RateLimiter {
  private readonly windows: readonly RateWindow[];
  private readonly clock: Clock;
  private readonly maxWaitMs: number;
  private readonly history: number[] = [];
  private readonly maxHistory: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions = {}) {
    this.windows = options.windows ?? DEFAULT_RATE_WINDOWS;
    this.clock = options.clock ?? systemClock;
    this.maxWaitMs = options.maxWaitMs ?? 30_000;
    this.maxHistory = Math.max(...this.windows.map((w) => w.limit));
  }

  /** Wait for a request slot (FIFO). Throws RateLimitError if the wait would be too long. */
  acquire(signal?: AbortSignal): Promise<void> {
    const next = this.queue.then(() => this.take(signal));
    // Keep the chain alive even if this caller fails.
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Milliseconds until a slot is free (0 if one is free now). */
  waitTime(): number {
    const now = this.clock.now();
    let wait = 0;
    for (const { limit, windowMs } of this.windows) {
      const inWindow = this.history.filter((t) => t > now - windowMs);
      if (inWindow.length >= limit) {
        const oldestBlocking = inWindow[inWindow.length - limit] ?? now;
        wait = Math.max(wait, oldestBlocking + windowMs - now);
      }
    }
    return wait;
  }

  private async take(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const wait = this.waitTime();
      if (wait === 0) break;
      if (wait > this.maxWaitMs) {
        throw new RateLimitError(
          'Local request budget for the Netatmo API is exhausted (protecting your account from Netatmo rate limits).',
          wait,
        );
      }
      await this.clock.sleep(wait, signal);
    }
    this.history.push(this.clock.now());
    if (this.history.length > this.maxHistory)
      this.history.splice(0, this.history.length - this.maxHistory);
  }
}
