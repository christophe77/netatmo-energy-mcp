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

/**
 * Break a stale lock without racing another breaker: move it aside atomically, then check that
 * what was moved is still the stale lock we inspected. If a fresh lock was moved by mistake,
 * put it back with link(), which fails rather than overwrite a lock created in the meantime.
 */
async function breakStaleLock(lockPath: string, staleContent: string): Promise<void> {
  const aside = `${lockPath}.${randomBytes(6).toString('hex')}.stale`;
  try {
    await fs.rename(lockPath, aside);
  } catch (error) {
    // Gone already, or another process is breaking it at this moment.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || isContended(error)) return;
    throw error;
  }
  const moved = await readOrUndefined(aside);
  if (moved !== staleContent) {
    try {
      await fs.link(aside, lockPath);
    } catch {
      // Another process already holds a newer lock; the moved one is lost to its owner,
      // whose release() tolerates a missing lock.
    }
  }
  await fs.rm(aside, { force: true });
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
        await breakStaleLock(lockPath, content);
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
