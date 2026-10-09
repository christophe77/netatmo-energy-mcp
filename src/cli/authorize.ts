import { CredentialStore } from '../auth/credential-store.js';
import { startCallbackServer } from '../auth/callback-server.js';
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  exchangeAuthorizationCode,
  parseRedirectUrl,
  READ_ONLY_SCOPES,
  READ_WRITE_SCOPES,
} from '../auth/oauth.js';
import type { TokenSet } from '../auth/token-set.js';
import { openBrowser } from './browser.js';
import type { CommandContext } from './index.js';
import { isInteractive, prompt, promptHidden } from './prompt.js';

/** Options shared by `login` and `remote setup`. */
export const AUTHORIZE_OPTIONS = {
  manual: { type: 'boolean', default: false },
  'no-browser': { type: 'boolean', default: false },
  'client-id': { type: 'string' },
  timeout: { type: 'string', default: '300' },
  'experimental-pkce': { type: 'boolean', default: false },
  write: { type: 'boolean', default: false },
} as const;

export interface AuthorizeValues {
  manual?: boolean;
  'no-browser'?: boolean;
  'client-id'?: string;
  timeout?: string;
  'experimental-pkce'?: boolean;
  write?: boolean;
}

export interface Authorization {
  clientId: string;
  clientSecret: string;
  tokens: TokenSet;
  scopes: readonly string[];
  usedPkce: boolean;
}

/**
 * Runs Netatmo's OAuth authorization code flow (loopback callback or manual paste) and returns
 * the app credentials and fresh tokens without storing anything. Returns an exit code when the
 * flow cannot start (missing credentials, bad options). Errors from Netatmo are thrown.
 */
export async function authorizeNetatmo(
  { config, out, logger }: Pick<CommandContext, 'config' | 'out' | 'logger'>,
  values: AuthorizeValues,
  purpose: string,
): Promise<Authorization | number> {
  const timeoutS = Number(values.timeout ?? '300');
  if (!Number.isFinite(timeoutS) || timeoutS < 10) {
    out.error('--timeout must be a number of seconds (minimum 10).');
    return 2;
  }

  const stored = await new CredentialStore(config.paths, logger).read().catch(() => undefined);

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

  // 2. Authorization request. Write access is opt-in (ADR-0012).
  const scopes: readonly string[] = values.write ? READ_WRITE_SCOPES : READ_ONLY_SCOPES;
  const state = createState();
  const pkce = values['experimental-pkce'] ? await createPkcePair() : undefined;
  const authorizeUrl = buildAuthorizeUrl({
    clientId,
    redirectUri: config.redirectUri,
    state,
    scopes,
    ...(pkce && { codeChallenge: pkce.challenge }),
  });

  out.line(
    values.write
      ? `Requesting read AND write access for ${purpose} (scope: ${scopes.join(' ')}). The assistant will be able to change the heating, always after your confirmation.`
      : `Requesting read-only access for ${purpose} (scope: ${scopes.join(' ')}).`,
  );
  out.line(`Redirect URI (must be registered in your Netatmo app): ${config.redirectUri}`);
  out.line();

  let code: string;
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
    code = parseRedirectUrl(await prompt('Redirected URL: '), state, config.redirectUri);
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
    scopes,
    now: Date.now(),
    ...(pkce && { codeVerifier: pkce.verifier }),
  });
  const missing = scopes.filter((s) => !tokens.scope.includes(s));
  if (tokens.scope.length > 0 && missing.length > 0) {
    out.line(`Warning: the granted scope is missing ${missing.join(', ')}.`);
  }
  return { clientId, clientSecret, tokens, scopes, usedPkce: pkce !== undefined };
}

function missingCredentials(out: CommandContext['out']): number {
  out.error(
    'No Netatmo app credentials found. Set NETATMO_CLIENT_ID and NETATMO_CLIENT_SECRET, or run this command in an interactive terminal.',
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
