import fs from 'node:fs/promises';
import { createRuntime } from '../../app.js';
import type { StoredCredentials } from '../../auth/credential-store.js';
import { READ_ONLY_SCOPES } from '../../auth/oauth.js';
import { describeWindowsAcl, windowsAclPrincipals } from '../../auth/secure-fs.js';
import { resolveClientCredentials } from '../../auth/token-manager.js';
import { summarizeDevices, toHomes } from '../../domain/homes/topology.js';
import { AppError } from '../../errors.js';
import type { Command, CommandContext } from '../index.js';
import { formatDuration, maskId } from './status.js';

type Result = 'ok' | 'warn' | 'fail';
const MARK: Record<Result, string> = { ok: '[ok]  ', warn: '[warn]', fail: '[FAIL]' };

export function nodeVersionOk(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}

export const doctorCommand: Command = {
  name: 'doctor',
  summary: 'Check configuration, credentials and API connectivity without revealing secrets.',
  usage: 'netatmo-energy-mcp doctor',
  run: runDoctor,
};

async function runDoctor({ config, out, logger }: CommandContext): Promise<number> {
  let failures = 0;
  const report = (result: Result, message: string) => {
    if (result === 'fail') failures += 1;
    out.line(`${MARK[result]} ${message}`);
  };

  report(
    nodeVersionOk(process.version) ? 'ok' : 'fail',
    `Node.js ${process.version} (requires >= 22.19)`,
  );

  // Configuration folder and permissions.
  try {
    const stat = await fs.stat(config.paths.dir);
    if (process.platform === 'win32') {
      const acl = describeWindowsAcl(config.paths.dir);
      const principals = windowsAclPrincipals(config.paths.dir)?.length ?? 0;
      const inherited = acl?.includes('(I)') ?? true;
      report(
        acl && principals <= 2 && !inherited ? 'ok' : 'warn',
        `Config folder ${config.paths.dir} (${acl ? `${principals} principals with access${inherited ? ', inherited permissions' : ''}` : 'ACL unreadable'})`,
      );
    } else {
      const mode = stat.mode & 0o777;
      report(
        (mode & 0o077) === 0 ? 'ok' : 'warn',
        `Config folder ${config.paths.dir} (mode ${mode.toString(8)})`,
      );
    }
  } catch {
    report('fail', `Config folder ${config.paths.dir} does not exist. Run "login".`);
  }

  const runtime = createRuntime(config, logger);
  let stored: StoredCredentials | undefined;
  try {
    stored = await runtime.store.read();
  } catch (error) {
    report('fail', error instanceof Error ? error.message : String(error));
  }

  const client = resolveClientCredentials(config.envClient, stored);
  report(
    client ? 'ok' : 'fail',
    client
      ? `Netatmo app credentials: client ID ${maskId(client.clientId)} (source: ${client.source})`
      : 'Netatmo app credentials missing (set NETATMO_CLIENT_ID/NETATMO_CLIENT_SECRET or run "login")',
  );

  const tokens = stored?.tokens;
  if (!tokens) {
    report('fail', 'No tokens stored. Run "login".');
    return finish(out, failures);
  }
  const granted = tokens.scope;
  const missing = READ_ONLY_SCOPES.filter((s) => !granted.includes(s));
  const writeScopes = granted.filter((s) => s.startsWith('write_'));
  report(
    missing.length === 0 && writeScopes.length === 0
      ? 'ok'
      : granted.length === 0
        ? 'warn'
        : 'fail',
    granted.length === 0
      ? 'Granted scope not reported by Netatmo'
      : `Granted scope: ${granted.join(' ')}${writeScopes.length > 0 ? ' (write scopes are not needed; log in again)' : ''}`,
  );

  try {
    await runtime.tokens.getAccessToken();
    const fresh = await runtime.store.read();
    const remaining = (fresh?.tokens?.expiresAt ?? 0) - Date.now();
    report('ok', `Access token valid for ${formatDuration(remaining)}`);
  } catch (error) {
    report('fail', `Token check failed: ${describe(error)}`);
    return finish(out, failures);
  }

  try {
    const homes = toHomes((await runtime.client.homesData()).body);
    report(homes.length > 0 ? 'ok' : 'warn', `Netatmo API reachable: ${homes.length} home(s)`);
    for (const home of homes) {
      report(
        'ok',
        `${home.name}: ${home.rooms.length} rooms; ${summarizeDevices(home) || 'no devices'}`,
      );
    }
  } catch (error) {
    report('fail', `Netatmo API call failed: ${describe(error)}`);
  }
  return finish(out, failures);
}

function describe(error: unknown): string {
  if (error instanceof AppError)
    return error.hint ? `${error.message} ${error.hint}` : error.message;
  return error instanceof Error ? error.message : String(error);
}

function finish(out: CommandContext['out'], failures: number): number {
  out.line();
  out.line(failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`);
  return failures === 0 ? 0 : 1;
}
