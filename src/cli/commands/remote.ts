import { AppError } from '../../errors.js';
import { USER_AGENT } from '../../version.js';
import { AUTHORIZE_OPTIONS, authorizeNetatmo } from '../authorize.js';
import { parseCommandArgs, type Command, type CommandContext } from '../index.js';
import { isInteractive, promptHidden } from '../prompt.js';

const USAGE = `netatmo-energy-mcp remote setup <url> [--write] [--manual] [--no-browser] [--client-id <id>] [--timeout <seconds>]
netatmo-energy-mcp remote status <url>
netatmo-energy-mcp remote invite <url>
netatmo-energy-mcp remote accounts <url>
netatmo-energy-mcp remote revoke <url> [--account <key>]
netatmo-energy-mcp remote remove <url> --account <key>

Links your own remote server (the Cloudflare Worker in remote/, see remote/README.md) to your
Netatmo account, so assistants such as ChatGPT or Claude on the web and on mobile can use it.

  setup   Signs in to Netatmo in your browser (same app and flow as "login"; --write also grants
          write access), then sends the app credentials and the new tokens to the server over
          HTTPS. They are encrypted there. Nothing is saved on this computer.
  status  Shows whether the server is linked, its scopes and write mode.
  invite  Creates a single-use invite code (7 days) when the server runs with ONBOARDING=invite,
          so someone else can connect their own Netatmo account from the consent page.
  accounts  Lists the accounts on the server and the assistants (connectors) connected to each.
  revoke  Disconnects every assistant (or only those of --account): they must sign in again.
          Do this after changing OWNER_PASSWORD or if a device or connector may be compromised.
  remove  Disconnects the assistants of an onboarded account and erases its data.

  <url>   The server's address, e.g. https://netatmo-energy-mcp.<you>.workers.dev

The server's SETUP_TOKEN is read from NETATMO_MCP_SETUP_TOKEN or a hidden prompt. It is never
accepted on the command line, where it would end up in shell history.`;

export const remoteCommand: Command = {
  name: 'remote',
  summary: 'Link your remote server (Cloudflare Worker) to your Netatmo account.',
  usage: USAGE,
  run: runRemote,
};

interface RemoteStatus {
  version?: string;
  linked: boolean;
  scopes: string[];
  writeMode: boolean;
  linkedAt?: string;
  tokenExpiresAt?: string;
  homes?: number;
}

async function runRemote(ctx: CommandContext): Promise<number> {
  const { out, argv } = ctx;
  const [sub, rawUrl, ...rest] = argv;
  const subs = ['setup', 'status', 'invite', 'accounts', 'revoke', 'remove'];
  if (!sub || !subs.includes(sub) || !rawUrl) {
    out.error(USAGE);
    return 2;
  }
  const base = serverOrigin(rawUrl);
  if (!base) {
    out.error('The server URL must use https (http is accepted only for localhost).');
    return 2;
  }
  const values = sub === 'setup' ? parseCommandArgs(rest, AUTHORIZE_OPTIONS).values : undefined;
  const target =
    sub === 'revoke' || sub === 'remove'
      ? parseCommandArgs(rest, { account: { type: 'string' } }).values.account
      : undefined;
  if (sub === 'remove' && !target) {
    out.error('remove needs --account <key> (see "remote accounts").');
    return 2;
  }
  if (sub !== 'setup' && sub !== 'revoke' && sub !== 'remove' && rest.length > 0) {
    out.error(`Unexpected arguments: ${rest.join(' ')}`);
    return 2;
  }

  const setupToken = await readSetupToken(ctx);
  if (!setupToken) return 2;
  const api = new AdminApi(base, setupToken);

  try {
    // Check the server and the setup token first, before any Netatmo sign-in.
    const before = await api.status();
    if (sub === 'status') {
      printStatus(out, base, before);
      return before.linked ? 0 : 1;
    }
    if (sub === 'accounts') {
      const { accounts } = await api.accounts();
      for (const a of accounts) {
        const state = !a.linked
          ? 'not linked'
          : a.revoked
            ? 'revoked by Netatmo'
            : a.writeMode
              ? 'read + write'
              : 'read-only';
        out.line(`${a.account}  ${state}  ${a.connectors.length} connector(s)`);
        for (const c of a.connectors) out.line(`    ${c.client_id}  since ${c.created_at}`);
      }
      return 0;
    }
    if (sub === 'revoke') {
      const { revoked } = await api.post<{ revoked: number }>(
        '/admin/revoke',
        target ? { account: target } : {},
      );
      out.line(
        `Revoked ${revoked} connector authorization(s). Those assistants must sign in again.`,
      );
      return 0;
    }
    if (sub === 'remove') {
      const result = await api.post<{ removed: string; revoked: number }>('/admin/remove', {
        account: target,
      });
      out.line(
        `Removed account ${result.removed} and ${result.revoked} connector authorization(s).`,
      );
      return 0;
    }
    if (sub === 'invite') {
      const invite = await api.invite();
      out.line(`Invite code: ${invite.code}`);
      out.line(
        `Valid once, until ${invite.expires_at}. Share it privately; whoever uses it can link`,
      );
      out.line('their own Netatmo account to this server from the connector consent page.');
      return 0;
    }

    out.line(`Server: ${base} (version ${before.version ?? 'unknown'})`);
    out.line(
      'This creates a separate Netatmo authorization for the server; your local login is not changed.',
    );
    out.line();
    const auth = await authorizeNetatmo(ctx, values ?? {}, 'your remote server');
    if (typeof auth === 'number') return auth;

    const linked = await api.setup({
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      tokens: auth.tokens,
    });
    out.line();
    out.line(`Linked: ${linked.homes ?? '?'} home(s) found.`);
    printStatus(out, base, linked);
    out.line();
    out.line('Next: add this connector in ChatGPT, Claude or another assistant:');
    out.line(`  ${base}/mcp`);
    out.line('and sign in with your OWNER_PASSWORD on the consent page.');
    return 0;
  } catch (error) {
    if (error instanceof AppError) {
      out.error(`remote ${sub} failed: ${error.message}`);
      if (error.hint) out.error(error.hint);
      return 1;
    }
    throw error;
  }
}

/** https origin of the server (any /mcp suffix removed); http only on loopback. */
export function serverOrigin(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return undefined;
  if (url.username || url.password) return undefined;
  return url.origin;
}

async function readSetupToken({ config, out }: CommandContext): Promise<string | undefined> {
  if (config.setupToken) return config.setupToken;
  if (!isInteractive()) {
    out.error('Set NETATMO_MCP_SETUP_TOKEN, or run this command in an interactive terminal.');
    return undefined;
  }
  const token = await promptHidden("Server's SETUP_TOKEN (input hidden): ");
  return token || undefined;
}

function printStatus(out: CommandContext['out'], base: string, s: RemoteStatus): void {
  out.line(`Server:        ${base}${s.version ? ` (version ${s.version})` : ''}`);
  if (!s.linked) {
    out.line('Netatmo:       not linked. Run "netatmo-energy-mcp remote setup <url>".');
    return;
  }
  out.line(`Netatmo:       linked${s.linkedAt ? ` on ${s.linkedAt}` : ''}`);
  out.line(`Scope:         ${s.scopes.join(' ') || '(not reported)'}`);
  out.line(
    `Write mode:    ${s.writeMode ? 'on (heating changes possible after confirmation)' : 'off (read-only)'}`,
  );
  if (s.tokenExpiresAt)
    out.line(`Access token:  renewed automatically (current one until ${s.tokenExpiresAt})`);
}

class RemoteError extends AppError {
  override name = 'RemoteError';
}

/** Client for the server's /admin endpoints. Never logs or prints secrets. */
class AdminApi {
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  status(): Promise<RemoteStatus> {
    return this.call('GET', '/admin/status');
  }

  setup(link: unknown): Promise<RemoteStatus> {
    return this.call('POST', '/admin/setup', link);
  }

  invite(): Promise<{ code: string; expires_at: string }> {
    return this.call('POST', '/admin/invite', {});
  }

  accounts(): Promise<{
    accounts: (RemoteStatus & {
      account: string;
      revoked?: boolean;
      connectors: { client_id: string; created_at: string }[];
    })[];
  }> {
    return this.call('GET', '/admin/accounts');
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.call('POST', path, body);
  }

  private async call<T = RemoteStatus>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'User-Agent': USER_AGENT,
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (cause) {
      throw new RemoteError('NETATMO_UNAVAILABLE', `Could not reach ${this.base}.`, {
        hint: 'Check the URL and that the server is deployed (npx wrangler deploy in remote/).',
        cause,
      });
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return json as unknown as T;
    if (res.status === 409) {
      throw new RemoteError(
        'UNSUPPORTED_CAPABILITY',
        'Invites need ONBOARDING=invite on the server.',
        {
          hint: 'Set it in remote/wrangler.jsonc ("vars") and deploy again.',
        },
      );
    }
    if (res.status === 401) {
      throw new RemoteError('AUTH_REQUIRED', 'The server refused the setup token.', {
        hint: 'Use the SETUP_TOKEN secret set on the server (npx wrangler secret put SETUP_TOKEN).',
      });
    }
    if (res.status === 429) {
      throw new RemoteError(
        'RATE_LIMITED',
        'Too many wrong setup tokens: the server is locked for 15 minutes.',
      );
    }
    if (res.status === 404) {
      throw new RemoteError('NOT_FOUND', 'This address is not a netatmo-energy-mcp remote server.');
    }
    const message = typeof json.message === 'string' ? json.message : `HTTP ${res.status}`;
    throw new RemoteError('INVALID_RESPONSE', `The server rejected the request: ${message}`);
  }
}
