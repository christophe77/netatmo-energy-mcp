import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { systemClock, type Clock } from '../utils/clock.js';
import type { Logger } from '../utils/logger.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface SecureDirResult {
  created: boolean;
  /** Windows only: whether the ACL was restricted to the current user and SYSTEM. */
  aclRestricted?: boolean;
}

/**
 * Create the directory if needed with owner-only permissions.
 * On Windows, POSIX modes are meaningless, so a freshly created directory gets an
 * explicit ACL (current user + SYSTEM, inherited by files) via icacls. Best effort.
 */
export async function ensureSecureDir(
  dir: string,
  logger: Logger,
  opts: { platform?: NodeJS.Platform; forceAcl?: boolean } = {},
): Promise<SecureDirResult> {
  const platform = opts.platform ?? process.platform;
  let created = false;
  try {
    await fs.mkdir(dir, { mode: DIR_MODE });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
      created = true;
    } else if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  if (platform === 'win32') {
    if (!created && !opts.forceAcl) return { created };
    const aclRestricted = restrictWindowsAcl(dir, logger);
    return { created, aclRestricted };
  }

  if (!created) {
    // Tighten a pre-existing directory that is group/world accessible.
    const stat = await fs.stat(dir);
    if ((stat.mode & 0o077) !== 0) {
      await fs.chmod(dir, DIR_MODE);
      logger.warn('Tightened permissions on the configuration directory', { dir });
    }
  }
  return { created };
}

/** Absolute path to a Windows system tool, so PATH entries (e.g. Git Bash coreutils) cannot shadow it. */
function system32(exe: string): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return path.win32.join(root, 'System32', exe);
}

/** Current user's SID, e.g. "S-1-5-21-…", read via `whoami /user`. */
export function currentWindowsSid(): string | undefined {
  const res = spawnSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  if (res.status !== 0) return undefined;
  const match = /"(S-1-[\d-]+)"\s*$/m.exec(res.stdout.trim());
  return match?.[1];
}

export function restrictWindowsAcl(dir: string, logger: Logger): boolean {
  const sid = currentWindowsSid();
  if (!sid) {
    logger.warn('Could not determine the current Windows user SID; directory ACL left unchanged');
    return false;
  }
  const res = spawnSync(
    system32('icacls.exe'),
    [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
  );
  if (res.status !== 0) {
    logger.warn('Could not restrict the configuration directory ACL', {
      status: res.status,
      stderr: res.stderr.trim(),
    });
    return false;
  }
  return true;
}

/** Windows: lists principals with access to `dir`, for `doctor`. */
export function describeWindowsAcl(dir: string): string | undefined {
  const res = spawnSync(system32('icacls.exe'), [dir], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  return res.status === 0 ? res.stdout.trim() : undefined;
}

export async function readFileIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Atomically replace `file`: write a sibling temp file (0600), fsync, then rename over the
 * target. Readers always see either the complete old content or the complete new content.
 * On Windows, rename can fail transiently while another process holds the target open, so
 * it is retried with backoff for about 2 seconds.
 */
export async function writeFileAtomic(
  file: string,
  content: string,
  opts: { clock?: Clock; platform?: NodeJS.Platform } = {},
): Promise<void> {
  const clock = opts.clock ?? systemClock;
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  const handle = await fs.open(
    tmp,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    FILE_MODE,
  );
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  const delays = [25, 50, 100, 200, 400, 600, 800];
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      const delay = delays[attempt];
      if (!RENAME_RETRY_CODES.has(code) || delay === undefined) {
        await fs.rm(tmp, { force: true });
        throw error;
      }
      await clock.sleep(delay);
    }
  }
  if ((opts.platform ?? process.platform) !== 'win32') {
    await fs.chmod(file, FILE_MODE);
  }
}
