/** One heating change attempted through the MCP server (ADR-0012). */
export interface AuditEntry {
  time: string;
  action: string;
  params: Record<string, unknown>;
  /** "unknown": no clear answer from Netatmo (network error, 5xx, cancelled after sending). */
  outcome: 'applied' | 'failed' | 'unknown';
  error?: string;
}

/**
 * Append-only record of heating changes. The local server writes `changes.log` in the
 * configuration folder; the remote server keeps it in the account's Durable Object (ADR-0014).
 * Implementations must never fail the operation: the change has already been sent.
 */
export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}
