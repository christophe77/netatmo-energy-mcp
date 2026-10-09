import { CredentialStore } from '../../auth/credential-store.js';
import { ensureSecureDir } from '../../auth/secure-fs.js';
import { AppError } from '../../errors.js';
import { AUTHORIZE_OPTIONS, authorizeNetatmo } from '../authorize.js';
import { parseCommandArgs, type Command, type CommandContext } from '../index.js';
import { verifyAccount } from './verify.js';

const USAGE = `netatmo-energy-mcp login [--write] [--manual] [--no-browser] [--client-id <id>] [--timeout <seconds>]

  --write              Also grant write access (write_thermostat): lets the assistant change setpoints,
                       modes and schedules, always after your confirmation. Without it, read-only.

  --manual             Do not start a local callback server. Paste the redirected URL instead.
  --no-browser         Print the authorization URL without opening a browser.
  --client-id <id>     Netatmo app client ID (otherwise NETATMO_CLIENT_ID, the stored one, or a prompt).
  --timeout <seconds>  How long to wait for the browser redirect (default 300).
  --experimental-pkce  Also send an RFC 7636 PKCE challenge (undocumented by Netatmo; for validation).

The client secret is read from NETATMO_CLIENT_SECRET, the stored credentials, or a hidden prompt.
It is never accepted on the command line, where it would end up in shell history.`;

export const loginCommand: Command = {
  name: 'login',
  summary: 'Authorize read-only access to your Netatmo account (OAuth2, browser-based).',
  usage: USAGE,
  run: runLogin,
};

async function runLogin({ config, out, logger, argv }: CommandContext): Promise<number> {
  const { values } = parseCommandArgs(argv, AUTHORIZE_OPTIONS);
  try {
    const auth = await authorizeNetatmo({ config, out, logger }, values, 'this computer');
    if (typeof auth === 'number') return auth;

    // Persist (replaces any previous credentials atomically, under the lock).
    const dir = await ensureSecureDir(config.paths.dir, logger, { forceAcl: true });
    if (dir.aclRestricted === false) {
      out.line('Warning: could not restrict the configuration folder permissions on Windows.');
    }
    await new CredentialStore(config.paths, logger).update(() => ({
      version: 1,
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      tokens: auth.tokens,
    }));

    out.line();
    out.line('Logged in. Tokens and the app client ID and secret were saved to:');
    out.line(`  ${config.paths.credentials}`);
    if (config.envClient.clientSecret) {
      out.line(
        'The secret from NETATMO_CLIENT_SECRET was stored too, so MCP client configurations need no secrets. Run "logout" to delete the file.',
      );
    }
    if (auth.usedPkce) out.line('Note: login succeeded with a PKCE challenge (experimental flag).');
  } catch (error) {
    if (error instanceof AppError) {
      out.error(`Login failed: ${error.message}`);
      if (error.hint) out.error(error.hint);
      return 1;
    }
    throw error;
  }

  // Confirm that the token works (read-only call).
  return verifyAccount({ config, out, logger });
}
