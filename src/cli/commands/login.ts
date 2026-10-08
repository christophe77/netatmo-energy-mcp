import { CredentialStore } from '../../auth/credential-store.js';
import { startCallbackServer } from '../../auth/callback-server.js';
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  exchangeAuthorizationCode,
  parseRedirectUrl,
  READ_ONLY_SCOPES,
} from '../../auth/oauth.js';
import { ensureSecureDir } from '../../auth/secure-fs.js';
import { AppError } from '../../errors.js';
import { openBrowser } from '../browser.js';
import { parseCommandArgs, type Command, type CommandContext } from '../index.js';
import { isInteractive, prompt, promptHidden } from '../prompt.js';
import { verifyAccount } from './verify.js';

const USAGE = `netatmo-energy-mcp login [--manual] [--no-browser] [--client-id <id>] [--timeout <seconds>]

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
  const { values } = parseCommandArgs(argv, {
    manual: { type: 'boolean', default: false },
    'no-browser': { type: 'boolean', default: false },
    'client-id': { type: 'string' },
    timeout: { type: 'string', default: '300' },
    'experimental-pkce': { type: 'boolean', default: false },
  });
  const timeoutS = Number(values.timeout);
  if (!Number.isFinite(timeoutS) || timeoutS < 10) {
    out.error('--timeout must be a number of seconds (minimum 10).');
    return 2;
  }

  const store = new CredentialStore(config.paths, logger);
  const stored = await store.read().catch(() => undefined);

  // 1. Client credentials: env > flag > stored > prompt.
  let clientId = config.envClient.clientId ?? values['client-id'] ?? stored?.clientId;
  if (!clientId) {
    if (!isInteractive()) return missingCredentials(out);
    printAppSetup(out, config.redirectUri);
    clientId = await prompt('Netatmo app client ID: ');
  }
  let clientSecret =
    config.envClient.clientSecret ??
    (stored?.clientId === clientId ? stored.clientSecret : undefined);
  if (!clientSecret) {
    if (!isInteractive()) return missingCredentials(out);
    clientSecret = await promptHidden('Netatmo app client secret (input hidden): ');
  }
  if (!clientId || !clientSecret) {
    out.error('A client ID and a client secret are both required.');
    return 2;
  }

  // 2. Authorization request.
  const state = createState();
  const pkce = values['experimental-pkce'] ? createPkcePair() : undefined;
  const authorizeUrl = buildAuthorizeUrl({
    clientId,
    redirectUri: config.redirectUri,
    state,
    scopes: READ_ONLY_SCOPES,
    ...(pkce && { codeChallenge: pkce.challenge }),
  });

  out.line(`Requesting read-only access (scope: ${READ_ONLY_SCOPES.join(' ')}).`);
  out.line(`Redirect URI (must be registered in your Netatmo app): ${config.redirectUri}`);
  out.line();

  let code: string;
  try {
    if (values.manual) {
      out.line('Open this URL in a browser, sign in on netatmo.com and approve access:');
      out.line();
      out.line(`  ${authorizeUrl}`);
      out.line();
      out.line(
        'Your browser will then be redirected to the redirect URI. The page may fail to load;',
      );
      out.line('that is expected. Copy the full URL from the address bar and paste it here.');
      if (!isInteractive()) {
        out.error('--manual needs an interactive terminal.');
        return 2;
      }
      code = parseRedirectUrl(await prompt('Redirected URL: '), state);
    } else {
      const server = await startCallbackServer({
        redirectUri: config.redirectUri,
        expectedState: state,
        timeoutMs: timeoutS * 1000,
      });
      const opened = !values['no-browser'] && openBrowser(authorizeUrl);
      out.line(
        opened
          ? 'Your browser should open. If it does not, open this URL:'
          : 'Open this URL in a browser:',
      );
      out.line();
      out.line(`  ${authorizeUrl}`);
      out.line();
      out.line(`Waiting for authorization (up to ${timeoutS} s)…`);
      code = await server.code;
    }

    // 3. Code exchange.
    const { tokens } = await exchangeAuthorizationCode({
      clientId,
      clientSecret,
      code,
      redirectUri: config.redirectUri,
      now: Date.now(),
      ...(pkce && { codeVerifier: pkce.verifier }),
    });

    // 4. Persist (replaces any previous credentials atomically, under the lock).
    const dir = await ensureSecureDir(config.paths.dir, logger, { forceAcl: true });
    if (dir.aclRestricted === false) {
      out.line('Warning: could not restrict the configuration folder permissions on Windows.');
    }
    const finalClientId = clientId;
    const finalSecret = clientSecret;
    await store.update(() => ({
      version: 1,
      clientId: finalClientId,
      clientSecret: finalSecret,
      tokens,
    }));

    out.line();
    out.line('Logged in. Tokens saved to:');
    out.line(`  ${config.paths.credentials}`);
    const missing = READ_ONLY_SCOPES.filter((s) => !tokens.scope.includes(s));
    if (tokens.scope.length > 0 && missing.length > 0) {
      out.line(`Warning: the granted scope is missing ${missing.join(', ')}.`);
    }
    if (pkce) out.line('Note: login succeeded with a PKCE challenge (experimental flag).');
  } catch (error) {
    if (error instanceof AppError) {
      out.error(`Login failed: ${error.message}`);
      if (error.hint) out.error(error.hint);
      return 1;
    }
    throw error;
  }

  // 5. Confirm that the token works (read-only call).
  return verifyAccount({ config, out, logger });
}

function missingCredentials(out: CommandContext['out']): number {
  out.error(
    'No Netatmo app credentials found. Set NETATMO_CLIENT_ID and NETATMO_CLIENT_SECRET, or run "login" in an interactive terminal.',
  );
  return 2;
}

function printAppSetup(out: CommandContext['out'], redirectUri: string): void {
  out.line('You need your own (free) Netatmo developer app:');
  out.line('  1. Sign in at https://dev.netatmo.com/apps and choose "Create".');
  out.line('  2. Give it any name and description (e.g. "My heating MCP").');
  out.line(`  3. Set the redirect URI to: ${redirectUri}`);
  out.line('  4. Save, then copy the client ID and client secret below.');
  out.line('See docs/authentication.md for details.');
  out.line();
}
