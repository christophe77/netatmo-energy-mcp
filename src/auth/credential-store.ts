import fs from 'node:fs/promises';
import * as z from 'zod';
import type { ConfigPaths } from '../config/paths.js';
import { AuthRequiredError } from '../errors.js';
import { systemClock, type Clock } from '../utils/clock.js';
import type { Logger } from '../utils/logger.js';
import { acquireFileLock, LockTimeoutError } from './lock.js';
import { ensureSecureDir, readFileIfExists, writeFileAtomic } from './secure-fs.js';
import type { TokenSet as NeutralTokenSet } from './token-set.js';

const tokenSetSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** Epoch ms. */
  expiresAt: z.number(),
  /** Epoch ms. */
  obtainedAt: z.number(),
  scope: z.array(z.string()),
  /** The app that obtained these tokens. Refresh only works with the same app. */
  clientId: z.string().min(1),
});

// The schema must keep matching the runtime-neutral TokenSet shared with the remote server.
export type TokenSet = z.infer<typeof tokenSetSchema> & NeutralTokenSet;

const credentialsSchema = z.object({
  version: z.literal(1),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
  tokens: tokenSetSchema.optional(),
});

export type StoredCredentials = z.infer<typeof credentialsSchema>;

export class CorruptCredentialsError extends AuthRequiredError {
  override name = 'CorruptCredentialsError';
}

/**
 * Persistent store for client credentials and OAuth tokens (ADR-0005).
 * All mutations go through `update`, which holds the cross-process lock and writes atomically.
 */
export class CredentialStore {
  constructor(
    readonly paths: ConfigPaths,
    private readonly logger: Logger,
    private readonly clock: Clock = systemClock,
  ) {}

  async read(): Promise<StoredCredentials | undefined> {
    const raw = await readFileIfExists(this.paths.credentials);
    if (raw === undefined) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new CorruptCredentialsError(
        `The credentials file is not valid JSON: ${this.paths.credentials}`,
      );
    }
    const parsed = credentialsSchema.safeParse(json);
    if (!parsed.success) {
      throw new CorruptCredentialsError(
        `The credentials file has an unexpected format: ${this.paths.credentials}`,
      );
    }
    return parsed.data;
  }

  /** Run `fn` while holding the credentials lock. */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await ensureSecureDir(this.paths.dir, this.logger);
    let release: () => Promise<void>;
    try {
      release = await acquireFileLock(this.paths.lock, { clock: this.clock });
    } catch (error) {
      if (error instanceof LockTimeoutError) {
        throw new AuthRequiredError(
          'Timed out waiting for another netatmo-energy-mcp process to finish refreshing tokens.',
          {
            hint: `If no other process is running, delete ${this.paths.lock} and retry.`,
            cause: error,
          },
        );
      }
      throw error;
    }
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  /** Write the full credentials document. Caller must hold the lock (see `withLock`). */
  async writeUnlocked(credentials: StoredCredentials): Promise<void> {
    const valid = credentialsSchema.parse(credentials);
    await writeFileAtomic(this.paths.credentials, `${JSON.stringify(valid, null, 2)}\n`, {
      clock: this.clock,
    });
  }

  /** Read-modify-write under the lock. */
  async update(
    mutate: (current: StoredCredentials | undefined) => StoredCredentials,
  ): Promise<StoredCredentials> {
    return this.withLock(async () => {
      const next = mutate(await this.read().catch(() => undefined));
      await this.writeUnlocked(next);
      return next;
    });
  }

  /** Remove stored credentials. Returns whether a file existed. */
  async clear(): Promise<boolean> {
    return this.withLock(async () => {
      try {
        await fs.rm(this.paths.credentials);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    });
  }
}
