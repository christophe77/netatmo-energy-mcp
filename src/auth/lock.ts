import { randomBytes } from 'node:crypto';
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
 * Errors meaning "someone else is working on the lock file right now". Besides EEXIST, Windows
 * reports EPERM/EACCES/EBUSY while the file is being renamed or is pending deletion.
 */
const CONTENDED = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);
const isContended = (error: unknown) => CONTENDED.has((error as NodeJS.ErrnoException).code ?? '');

async function readOrUndefined(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || isContended(error)) return undefined;
    throw error;
  }
}

/** A breaker lock older than this was abandoned by a crashed process. */
const BREAKER_STALE_MS = 10_000;

/**
 * Break a stale lock without racing other breakers. Breakers first take a separate, exclusive
 * breaker lock; under it they check again that the lock file is still the stale one they
 * inspected, and only then remove it. Without this, two breakers could each move aside a lock
 * the other had just taken, letting two processes in at once.
 */
async function breakStaleLock(
  lockPath: string,
  staleContent: string,
  staleMs: number,
  clock: Clock,
): Promise<void> {
  const breaker = `${lockPath}.break`;
  try {
    const handle = await fs.open(
      breaker,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await handle.close();
  } catch (error) {
    if (!isContended(error)) throw error;
    // Another process is breaking it now. Clean up a breaker left behind by a crash.
    try {
      const stat = await fs.stat(breaker);
      if (clock.now() - stat.mtimeMs > BREAKER_STALE_MS) await fs.rm(breaker, { force: true });
    } catch {
      // Gone or busy: the other breaker is finishing.
    }
    return;
  }
  try {
    if ((await readOrUndefined(lockPath)) !== staleContent) return;
    const stat = await fs.stat(lockPath).catch(() => undefined);
    if (!stat || clock.now() - stat.mtimeMs <= staleMs) return;
    await fs.rm(lockPath, { force: true });
  } catch (error) {
    // Windows: the file is being read or deleted by another process; try again later.
    if (!isContended(error)) throw error;
  } finally {
    await fs.rm(breaker, { force: true }).catch(() => undefined);
  }
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
  const token = `${process.pid}:${clock.now()}:${randomBytes(8).toString('hex')}`;

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
        // Only remove the lock if it is still ours (it may have been broken as stale).
        if ((await readOrUndefined(lockPath)) !== token) return;
        try {
          await fs.rm(lockPath, { force: true });
        } catch (error) {
          // Windows: another process is reading or breaking it; it will be cleaned up as stale.
          if (!isContended(error)) throw error;
        }
      };
    } catch (error) {
      if (!isContended(error)) throw error;
    }

    try {
      const content = await readOrUndefined(lockPath);
      const stat = await fs.stat(lockPath);
      if (content !== undefined && clock.now() - stat.mtimeMs > staleMs) {
        await breakStaleLock(lockPath, content, staleMs, clock);
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if (!isContended(error)) throw error;
    }

    if (clock.now() >= deadline) {
      throw new LockTimeoutError(`Timed out waiting for lock ${lockPath}`);
    }
    await clock.sleep(pollMs);
  }
}
