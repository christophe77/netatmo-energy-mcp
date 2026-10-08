import { CredentialStore, type StoredCredentials } from '../../auth/credential-store.js';
import { resolveClientCredentials } from '../../auth/token-manager.js';
import { AppError } from '../../errors.js';
import { WRITE_SCOPE } from '../../netatmo/write-endpoints.js';
import type { Command } from '../index.js';

/** Show a short, non-secret prefix of an identifier. */
export function maskId(id: string): string {
  return id.length <= 6 ? '***' : `${id.slice(0, 4)}…${id.slice(-2)}`;
}

export function formatDuration(ms: number): string {
  const totalMin = Math.round(Math.abs(ms) / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export interface AuthSummary {
  loggedIn: boolean;
  lines: string[];
}

export function summarizeAuth(
  stored: StoredCredentials | undefined,
  envClient: { clientId?: string; clientSecret?: string },
  now: number,
  /** True when NETATMO_MCP_WRITE=0 forces read-only mode. */
  writeDisabled = false,
): AuthSummary {
  const lines: string[] = [];
  const client = resolveClientCredentials(envClient, stored);
  if (client) {
    lines.push(
      `App client ID:  ${maskId(client.clientId)} (from ${client.source === 'env' ? 'environment' : client.source === 'stored' ? 'stored credentials' : 'environment + stored credentials'})`,
    );
  } else {
    lines.push('App client ID:  not configured');
  }
  const tokens = stored?.tokens;
  if (!tokens) {
    lines.push('Tokens:         none (not logged in)');
    return { loggedIn: false, lines };
  }
  const remaining = tokens.expiresAt - now;
  lines.push(
    remaining > 0
      ? `Access token:   present, expires in ${formatDuration(remaining)} (renewed automatically)`
      : `Access token:   expired ${formatDuration(remaining)} ago (renewed automatically on next use)`,
  );
  lines.push('Refresh token:  present');
  lines.push(
    `Scope:          ${tokens.scope.length > 0 ? tokens.scope.join(' ') : '(not reported)'}`,
  );
  lines.push(`Obtained:       ${new Date(tokens.obtainedAt).toISOString()}`);
  lines.push(
    tokens.scope.includes(WRITE_SCOPE)
      ? writeDisabled
        ? 'Write mode:     granted, but disabled by NETATMO_MCP_WRITE=0 (read-only)'
        : 'Write mode:     granted (login --write): heating changes possible after confirmation'
      : 'Write mode:     not granted (read-only)',
  );
  const mismatch = client !== undefined && client.clientId !== tokens.clientId;
  if (mismatch) {
    lines.push(
      'Problem:        tokens belong to a different app than the configured client ID; run "login".',
    );
  }
  return { loggedIn: !mismatch && client !== undefined, lines };
}

export const statusCommand: Command = {
  name: 'status',
  summary: 'Show authentication status without revealing secrets.',
  usage: 'netatmo-energy-mcp status',
  run: async ({ config, out, logger }) => {
    const store = new CredentialStore(config.paths, logger);
    let stored: StoredCredentials | undefined;
    try {
      stored = await store.read();
    } catch (error) {
      if (error instanceof AppError) {
        out.error(error.message);
        if (error.hint) out.error(error.hint);
        return 1;
      }
      throw error;
    }
    out.line(`Config folder:  ${config.paths.dir}`);
    const summary = summarizeAuth(stored, config.envClient, Date.now(), config.write === 'off');
    for (const line of summary.lines) out.line(line);
    if (!summary.loggedIn)
      out.line('\nRun "netatmo-energy-mcp login" to connect your Netatmo account.');
    return summary.loggedIn ? 0 : 1;
  },
};
