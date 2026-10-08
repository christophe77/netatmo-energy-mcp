/** Injectable time source. Keeps token expiry, rate limiting and retries testable. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** Resolves after `ms`, or rejects with the signal's reason when aborted. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason as Error);
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason as Error);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};
