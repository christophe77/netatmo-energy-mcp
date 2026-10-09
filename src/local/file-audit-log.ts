import fs from 'node:fs/promises';
import type { AuditEntry, AuditLog } from '../domain/audit-log.js';
import type { Logger } from '../utils/logger.js';

/**
 * Local, append-only log of heating changes (ADR-0012): one JSON object per line in
 * `<config folder>/changes.log`, owner-only permissions.
 * Logging failures never fail the operation (the change has already been applied).
 */
export class FileAuditLog implements AuditLog {
  constructor(
    private readonly file: string,
    private readonly logger: Logger,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await fs.appendFile(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (error) {
      this.logger.warn('Could not write the change log', { error });
    }
  }
}
