import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { TokenProvider } from '../../src/auth/token-manager.js';
import type { Clock } from '../../src/utils/clock.js';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- convenience cast for JSON fixtures
export function fixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(path.join(import.meta.dirname, '..', 'fixtures', name), 'utf8'),
  ) as T;
}

/** A clock whose `sleep` advances time instantly and records requested delays. */
export function fakeClock(start = 1_767_225_600_000) {
  let now = start;
  const sleeps: number[] = [];
  const clock: Clock & { sleeps: number[]; advance(ms: number): void } = {
    now: () => now,
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
    advance: (ms) => {
      now += ms;
    },
  };
  return clock;
}

/** Token provider that hands out t1, then t2 after a rejection, … */
export class FakeTokens implements TokenProvider {
  index = 0;
  rejected: string[] = [];
  constructor(private readonly tokens = ['token-1', 'token-2', 'token-3']) {}
  getAccessToken(): Promise<string> {
    return Promise.resolve(this.tokens[this.index] ?? 'token-x');
  }
  handleRejectedToken(token: string): Promise<string> {
    this.rejected.push(token);
    this.index += 1;
    return this.getAccessToken();
  }
}
