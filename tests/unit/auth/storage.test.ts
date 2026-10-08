import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CorruptCredentialsError, CredentialStore } from '../../../src/auth/credential-store.js';
import { acquireFileLock, LockTimeoutError } from '../../../src/auth/lock.js';
import { writeFileAtomic } from '../../../src/auth/secure-fs.js';
import { configPaths } from '../../../src/config/paths.js';
import { silentLogger } from '../../../src/utils/logger.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'nem-test-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const posixIt = process.platform === 'win32' ? it.skip : it;

describe('writeFileAtomic', () => {
  it('creates and replaces a file without leaving temp files', async () => {
    const file = path.join(dir, 'f.json');
    await writeFileAtomic(file, 'one');
    await writeFileAtomic(file, 'two');
    expect(await fs.readFile(file, 'utf8')).toBe('two');
    expect(await fs.readdir(dir)).toEqual(['f.json']);
  });

  posixIt('writes with mode 0600', async () => {
    const file = path.join(dir, 'f.json');
    await writeFileAtomic(file, 'x');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('retries a transient EPERM on rename (Windows file in use)', async () => {
    const file = path.join(dir, 'f.json');
    const realRename = fs.rename.bind(fs);
    const spy = vi
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EPERM' }))
      .mockImplementation(realRename);
    await writeFileAtomic(file, 'ok', { clock: { now: () => 0, sleep: async () => {} } });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(file, 'utf8')).toBe('ok');
  });

  it('cleans up the temp file on a permanent rename failure', async () => {
    const file = path.join(dir, 'f.json');
    vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('nope'), { code: 'EXDEV' }));
    await expect(writeFileAtomic(file, 'x')).rejects.toThrow('nope');
    expect(await fs.readdir(dir)).toEqual([]);
  });
});

describe('acquireFileLock', () => {
  it('excludes a second holder until released', async () => {
    const lock = path.join(dir, 'l.lock');
    const release1 = await acquireFileLock(lock);
    let acquired2 = false;
    const p2 = acquireFileLock(lock, { pollMs: 5 }).then((r) => {
      acquired2 = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(acquired2).toBe(false);
    await release1();
    const release2 = await p2;
    expect(acquired2).toBe(true);
    await release2();
    await expect(fs.stat(lock)).rejects.toThrow();
  });

  it('breaks a stale lock left by a crashed process', async () => {
    const lock = path.join(dir, 'l.lock');
    await fs.writeFile(lock, 'dead');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);
    const release = await acquireFileLock(lock, { staleMs: 30_000 });
    await release();
  });

  it('times out on a fresh foreign lock', async () => {
    const lock = path.join(dir, 'l.lock');
    await fs.writeFile(lock, 'other');
    await expect(acquireFileLock(lock, { timeoutMs: 50, pollMs: 10 })).rejects.toBeInstanceOf(
      LockTimeoutError,
    );
  });

  it('does not delete a lock that was taken over by someone else', async () => {
    const lock = path.join(dir, 'l.lock');
    const release = await acquireFileLock(lock);
    await fs.writeFile(lock, 'someone-else');
    await release();
    expect(await fs.readFile(lock, 'utf8')).toBe('someone-else');
  });
});

describe('CredentialStore', () => {
  const tokens = {
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: 2,
    obtainedAt: 1,
    scope: ['read_thermostat'],
    clientId: 'cid',
  };

  it('returns undefined when nothing is stored', async () => {
    const store = new CredentialStore(configPaths(path.join(dir, 'cfg')), silentLogger);
    expect(await store.read()).toBeUndefined();
  });

  it('round-trips through update, creating the directory', async () => {
    const store = new CredentialStore(configPaths(path.join(dir, 'nested', 'cfg')), silentLogger);
    await store.update(() => ({ version: 1, clientId: 'cid', clientSecret: 's', tokens }));
    expect(await store.read()).toEqual({ version: 1, clientId: 'cid', clientSecret: 's', tokens });
    // The lock is released afterwards.
    await expect(fs.stat(store.paths.lock)).rejects.toThrow();
  });

  it('reports a corrupt file as an AUTH_REQUIRED error', async () => {
    const paths = configPaths(dir);
    await fs.writeFile(paths.credentials, '{not json');
    const store = new CredentialStore(paths, silentLogger);
    await expect(store.read()).rejects.toBeInstanceOf(CorruptCredentialsError);
    await fs.writeFile(paths.credentials, JSON.stringify({ version: 99 }));
    await expect(store.read()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('clears stored credentials', async () => {
    const store = new CredentialStore(configPaths(dir), silentLogger);
    await store.update(() => ({ version: 1, tokens }));
    expect(await store.clear()).toBe(true);
    expect(await store.clear()).toBe(false);
    expect(await store.read()).toBeUndefined();
  });
});
