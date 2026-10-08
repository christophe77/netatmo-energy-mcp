import fs from 'node:fs/promises';
import type { Logger } from '../utils/logger.js';

export interface AuditEntry {
  time: string;
  action: string;
  params: Record<string, unknown>;
  outcome: 'applied' | 'failed';
  error?: string;
}

/**
 * Local, append-only log of heating changes made through the MCP server (ADR-0012).
 * One JSON object per line in `<config folder>/changes.log`, owner-only permissions.
 * Logging failures never fail the operation (the change has already been applied).
 */
export class AuditLog {
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
