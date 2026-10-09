# ADR-0014: Remote account modes: pre-configured owner and onboarding

Status: Accepted (2026-10-09)
Date: 2026-10-09

## Context

ADR-0013 chose a remote MCP endpoint on Cloudflare Workers with
bring-your-own-app onboarding, and the spike validated OAuth with ChatGPT
and Claude on desktop and mobile. The maintainer wants the remote server to
work **both without and with onboarding**, depending on the use case:

- **One person, their own home.** They deploy the Worker to their own
  Cloudflare account and want no sign-up page: set it up once, then
  connect assistants.
- **Several people on one deployment.** Each person brings their own
  Netatmo app through the onboarding page (ADR-0013 §1).

The maintainer also chose to **ship self-hosting first** (0.3). The hosted
multi-user service on the maintainer's deployment follows in 0.4 on the
same code.

## Decision

### 1. Two account sources in one Worker

| Mode                       | Who                              | How the Netatmo account is linked                                         | Sign-in on the consent page    |
| -------------------------- | -------------------------------- | ------------------------------------------------------------------------- | ------------------------------ |
| **Owner** (pre-configured) | The deployer                     | Once, from the CLI: `netatmo-energy-mcp remote setup <url>`               | Owner password (Worker secret) |
| **Onboarding**             | Anyone allowed by the deployment | On the consent page: own Netatmo client ID and secret, then Netatmo login | The Netatmo login itself       |

`ONBOARDING` (Worker variable) selects what the consent page offers:

- `off`: owner mode only. This is the default and fits self-hosting.
- `invite`: onboarding with a single-use invite code. This is the
  setting for the 0.4 beta.
- `open`: anyone may onboard. Only after the 0.4 exit criteria.

Both modes end in the same place: an **account** with encrypted Netatmo
app credentials and tokens, write-mode choice and limits. The MCP tools
never know which mode created it.

### 2. Owner setup from the CLI (no onboarding page)

`netatmo-energy-mcp remote setup <worker-url> [--write]`:

1. It runs the same local OAuth login as `login`: loopback callback,
   own Netatmo app, optional `write_thermostat`. This produces a
   **separate grant** for the Worker. It never reuses the local server's
   refresh token, because Netatmo documents refresh-token rotation and
   two holders of one token would lock each other out.
2. It sends the client ID, client secret and the new tokens over HTTPS
   to `POST <url>/admin/setup`. The request is authenticated with
   `SETUP_TOKEN`, a Worker secret the owner created, compared in constant
   time.
3. The Worker encrypts them into the owner account and answers with the
   account summary (homes, scopes), never the secrets.

The secrets are never printed, logged or stored locally by `remote
setup`. Running it again replaces the owner's Netatmo link.
`remote status <url>` shows whether the owner account is linked and when
its tokens were last refreshed.

### 3. Onboarding (when `ONBOARDING` is not `off`)

As ADR-0013 §1:

1. The consent page asks for the Netatmo client ID and secret, plus an
   invite code in `invite` mode, and the read or read + write choice.
2. It redirects to Netatmo; the callback is `<url>/netatmo/callback`.
3. The code is exchanged server-side, then `homesdata` is called once.
4. The account key is `HMAC(server key, Netatmo user.id)`. No email is
   stored.

The consent page always shows the requesting client and its verified
domain (spike finding: ChatGPT and Claude both use Client ID Metadata
Documents).

### 4. Storage and concurrency

- **One Durable Object per account.** It holds the encrypted record
  (AES-GCM, key from the `DATA_KEY` secret) and the token refresh lock.
  A refresh is serialized inside the object, which replaces the local
  file lock. It also holds the short-lived caches, the per-account rate
  limiter, the write audit log and the single-use confirmation nonces.
- **OAuth grants** (MCP clients) stay in `OAUTH_KV`, handled by
  `@cloudflare/workers-oauth-provider`. A grant's encrypted props contain
  only the account key.

### 5. Shared core, two shells

The Netatmo client, domain, analytics and MCP tool registration become a
**runtime-neutral core**: no `node:fs`, `node:os`, `child_process` or
`process` access. Platform-specific pieces are injected:

| Seam                | Local (stdio, Node)   | Remote (Worker)                               |
| ------------------- | --------------------- | --------------------------------------------- |
| Token provider      | File store, file lock | Account Durable Object                        |
| Audit log           | `changes.log` file    | Durable Object storage, 90-day retention      |
| Confirmation tokens | In memory             | Sealed (AES-GCM) + single-use nonce in the DO |
| Logger output       | stderr                | `console` (Workers Logs), same redaction      |
| Clock, `fetch`      | Node                  | Workers                                       |

The remote shell lives in `remote/`, a separate package deployed with
Wrangler. It imports the core from `src/` (bundled), so the tools are
identical in both shells. The npm package stays the local server plus the
`remote` CLI commands.

### 6. Confirmations

Same rules as ADR-0012, with sealed tokens (ADR-0013 §4).
`NETATMO_MCP_CONFIRM` becomes a per-account setting, default `token` for
remote accounts: ChatGPT shows no MCP confirmation dialog, and Claude
already asks for per-tool approval on its side.

## Plan

| Phase | Content                                                                                                            | Done when                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| P1    | Core seams: injectable audit log, confirmation store, logger output; no Node imports in core. A test enforces it.  | Local server unchanged; all tests green                            |
| P2    | `remote/` Worker: OAuth provider, owner sign-in, `createMcpHandler` serving the real tools, account Durable Object | Read tools work against a fake Netatmo in the Workers test runtime |
| P3    | `remote setup` / `remote status` CLI and `/admin/setup`                                                            | Owner can link their home and use it from ChatGPT and Claude       |
| P4    | Onboarding (`ONBOARDING=invite\|open`), Netatmo callback, account key                                              | Second account onboarded and isolated from the owner's (tested)    |
| P5    | Sealed confirmation tokens, write tools remote, audit log in the DO                                                | ADR-0012 test suite passes against the remote shell                |
| P6    | Deploy guide, e2e against the emulator, independent security review, release 0.3.0                                 | Review findings fixed; live validation on the maintainer's home    |

## Consequences

- The local stdio server keeps working unchanged. P1 is a refactor
  behind the existing tests.
- Self-hosters need a Cloudflare account and Wrangler. The deploy guide
  must stay short: KV namespace, three secrets (`OWNER_PASSWORD`,
  `SETUP_TOKEN`, `DATA_KEY`), deploy, `remote setup`.
- `/admin/setup` is a new attack surface. It is protected by a
  high-entropy secret, rate-limited, and only ever writes the owner
  account.
- **To verify in P3:** whether Netatmo keeps two active grants for the
  same user and app (local `login` and `remote setup`). If not, `remote
setup` must warn that the local server will need `login` again.
