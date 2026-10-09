# Remote server (Cloudflare Workers)

Use your Netatmo heating from **ChatGPT, Claude and other assistants on
the web and on mobile**. Those assistants only accept remote MCP servers,
so this folder deploys the same tools as the local server to your own
Cloudflare account (free plan). Design: [ADR-0013](../docs/adr/0013-remote-hosted-service.md)
and [ADR-0014](../docs/adr/0014-remote-account-modes.md).

- **Your server, your account.** Your Netatmo app secret and tokens are
  stored encrypted (AES-GCM) in your Cloudflare account. Nothing goes
  through a third party.
- **Assistants sign in with OAuth.** Each assistant gets its own access,
  which you approve on a consent page with your owner password, and can
  revoke.
- **Read-only by default.** Write mode needs `remote setup --write`.
  Every change is then previewed and confirmed, with the same limits as
  locally (ADR-0012).

## What you need

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up).
- Node.js 22.19+ and pnpm, and a clone of this repository.
- Your Netatmo developer app (the one used for `login`), with redirect URI
  `http://localhost:8977/callback`.

## Deploy

From the repository root:

```bash
pnpm install --frozen-lockfile
```

(The Worker bundles the shared core from `../src`; the lockfile pins its
dependencies.)

```bash
cd remote
```

```bash
npm install --ignore-scripts
```

```bash
npx wrangler login
```

1. Create the OAuth storage and paste its `id` into `wrangler.jsonc`
   (`kv_namespaces`):
   ```bash
   npx wrangler kv namespace create OAUTH_KV
   ```
2. Deploy once to learn your URL (`https://netatmo-energy-mcp.<you>.workers.dev`):
   ```bash
   npx wrangler deploy
   ```
3. Set the secrets. Wrangler prompts for each value, so it never lands
   in your shell history.

   | Secret           | Value                                                               |
   | ---------------- | ------------------------------------------------------------------- |
   | `PUBLIC_URL`     | Your Worker URL from step 2, without a trailing slash               |
   | `OWNER_PASSWORD` | A long password (12+ characters) for the consent page               |
   | `SETUP_TOKEN`    | A random value of 32+ characters, used by the `remote` CLI commands |
   | `DATA_KEY`       | 32 random bytes in base64; see the command below                    |

   ```bash
   npx wrangler secret put PUBLIC_URL
   ```

   ```bash
   npx wrangler secret put OWNER_PASSWORD
   ```

   Generate the setup token and the data key with:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

   ```bash
   npx wrangler secret put SETUP_TOKEN
   ```

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

   ```bash
   npx wrangler secret put DATA_KEY
   ```

   Keep `DATA_KEY` safe: if it changes, stored Netatmo links can no longer
   be decrypted and must be set up again.

4. Link your Netatmo account (add `--write` to allow heating changes):
   ```bash
   npx netatmo-energy-mcp remote setup https://netatmo-energy-mcp.<you>.workers.dev
   ```
   It asks for the `SETUP_TOKEN`, opens the Netatmo sign-in in your browser
   (same app as `login`), then sends the new authorization to your server.
   Your local login is not changed.

## Connect an assistant

Connector URL: `https://netatmo-energy-mcp.<you>.workers.dev/mcp`

- **Claude** (claude.ai, desktop, mobile): Settings → Connectors → _Add
  custom connector_.
- **ChatGPT**: turn on developer mode (Settings → Security and login), then
  Settings → Plugins → _Create an MCP app_, with OAuth authentication.
  Press _Refresh_ on the app page if the tools do not appear.

On the consent page, check the client name and destination domain, enter
your owner password, and allow.

Only apps with a verified domain (ChatGPT, Claude) or apps on your own
computer can be approved. A self-registered app could otherwise pretend to
be ChatGPT to phish your owner password. To allow other MCP clients that
register themselves, set `ALLOW_UNVERIFIED_CLIENTS` to `1`.

### If ChatGPT shows no tools

- Open the app page and press **Refresh** (`Actualiser`) once the account
  shows as connected.
- If no account appears after you allowed access, or the sign-in window
  keeps spinning, delete the app in ChatGPT and create it again. ChatGPT
  can keep a failed first connection and stop calling the server; the
  server logs then show the token being issued but no `/mcp` request.

## Options

Set in `wrangler.jsonc` under `vars` (then deploy again):

| Variable                                                                         | Default       | Meaning                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ONBOARDING`                                                                     | `off`         | `invite`: other people can connect their own Netatmo account with an invite code (`netatmo-energy-mcp remote invite <url>`). `open`: anyone can; not recommended.                                                                                |
| `NETATMO_MCP_WRITE`                                                              | follows setup | `0` forces read-only mode.                                                                                                                                                                                                                       |
| `NETATMO_MCP_CONFIRM`                                                            | `token`       | `token`: the assistant shows a preview and asks you. `elicitation`: only a confirmation dialog from the client (2026-07-28 protocol clients only; 2025-era clients cannot be asked over stateless HTTP, so changes are refused). `auto`: either. |
| `MAX_ACCOUNTS`                                                                   | `20`          | Maximum number of onboarded accounts.                                                                                                                                                                                                            |
| `ALLOW_UNVERIFIED_CLIENTS`                                                       | unset         | `1` allows self-registered MCP clients with a remote redirect to be approved.                                                                                                                                                                    |
| `NETATMO_MCP_MIN_TEMP`, `NETATMO_MCP_MAX_TEMP`, `NETATMO_MCP_MAX_SETPOINT_HOURS` | 7, 28, 24     | Write limits.                                                                                                                                                                                                                                    |

With onboarding enabled, each person creates their own free Netatmo app
with redirect URI `https://netatmo-energy-mcp.<you>.workers.dev/netatmo/callback`,
then uses the second form on the consent page. Each account only sees its
own home.

## Check and maintain

```bash
npx netatmo-energy-mcp remote status https://netatmo-energy-mcp.<you>.workers.dev
```

- **Logs**: Cloudflare dashboard → Workers → netatmo-energy-mcp →
  Observability. One line per MCP request (client, method, status, size,
  JSON-RPC error code). Secrets, tokens, arguments and results are never
  logged. A wrong-password page with no typo usually means
  `OWNER_PASSWORD` is unset or too short: the log says so.
- **Accounts and connected assistants**: `remote accounts <url>`.
- **Revoke access**: `remote revoke <url>` disconnects every assistant
  (`--account <key>` for one account). They must sign in again. Do this
  after changing `OWNER_PASSWORD`, which does not revoke existing access by
  itself, or if a device may be compromised.
- **Remove an onboarded account**: `remote remove <url> --account <key>`
  revokes its assistants and erases its data.
- **Lockout**: 5 wrong passwords or setup tokens from the same client lock
  that client for 15 minutes; other clients are not affected. Requests to
  the consent page, client registration and the Netatmo callback are also
  rate-limited per client.
- **Connector lifetime**: assistants keep access for up to 30 days without
  signing in again, unless revoked.
- **Update**: `git pull`, `pnpm install` at the root, then `npx wrangler
deploy` here.

## Test locally

```bash
node test/e2e.mjs
```

It runs the Worker in the local emulator against a fake Netatmo (no
Cloudflare account needed) and walks setup, OAuth, every tool family, write
confirmations, onboarding, isolation and lockouts.
