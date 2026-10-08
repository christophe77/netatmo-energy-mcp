import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import { systemClock, type Clock } from '../utils/clock.js';

export class LockTimeoutError extends Error {
  override name = 'LockTimeoutError';
}

export interface LockOptions {
  /** A lock older than this is considered abandoned (crashed holder). */
  staleMs?: number;
  /** Give up waiting after this long. */
  timeoutMs?: number;
  pollMs?: number;
  clock?: Clock;
}

/**
 * Cross-process mutual exclusion through an exclusively created lock file.
 * Used to serialize token refreshes between concurrent MCP server processes (ADR-0005).
 * Returns a release function. Release is idempotent and ignores a lock that is already gone.
 */
export async function acquireFileLock(
  lockPath: string,
  options: LockOptions = {},
): Promise<() => Promise<void>> {
  const clock = options.clock ?? systemClock;
  const staleMs = options.staleMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollMs = options.pollMs ?? 100;
  const deadline = clock.now() + timeoutMs;
  const token = `${process.pid}:${clock.now()}:${Math.random().toString(36).slice(2)}`;

  for (;;) {
    try {
      const handle = await fs.open(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      try {
        await handle.writeFile(token, 'utf8');
      } finally {
        await handle.close();
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          // Only remove the lock if it is still ours (it may have been broken as stale).
          if ((await fs.readFile(lockPath, 'utf8')) === token)
            await fs.rm(lockPath, { force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    try {
      const stat = await fs.stat(lockPath);
      if (clock.now() - stat.mtimeMs > staleMs) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    if (clock.now() >= deadline) {
      throw new LockTimeoutError(`Timed out waiting for lock ${lockPath}`);
    }
    await clock.sleep(pollMs);
  }
}
