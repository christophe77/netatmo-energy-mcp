# ADR-0013: Remote access and a hosted multi-user service

Status: Accepted (2026-10-09)
Date: 2026-10-09

## Context

The server only speaks MCP over stdio on the user's machine (ADR-0002).
Assistants that only accept **remote** MCP servers cannot use it: ChatGPT
(web and mobile), Claude on the web and on mobile, and Mistral Le Chat.
The maintainer's goal is broader: **anyone with a Netatmo account should
be able to manage their home from any device and any assistant**.

That requires a server reachable over HTTPS, which changes the threat
model. Today the only path to a home is the user's own machine. A hosted
service would hold access to many people's heating, so it becomes a
target.

Constraints already established:

- **Netatmo quotas** (api-capabilities §7). Each app gets 2,000 requests
  per hour while it has fewer than 500 users, and every user gets 50 per
  10 s and 500 per hour. A single app shared by every user would run out
  of quota quickly: one history question can cost up to 8 requests.
- **Client secrets.** Netatmo needs a client secret to obtain and refresh
  tokens (ADR-0004). Today each user creates their own Netatmo app.
- **Write mode** (ADR-0012) is opt-in, bounded, and needs confirmation.
  ChatGPT does not show MCP confirmation dialogs, so remote clients will
  mostly use the preview + token flow.
- **The SDK** (`@modelcontextprotocol/server` 2.3.1) provides
  `createMcpHandler`, a web-standard `fetch` handler that serves both
  protocol eras **statelessly, per request**, a Cloudflare Workers JSON
  Schema validator, and OAuth/scope helpers. Statelessness matters: the
  current in-memory confirmation tokens, response cache, rate limiter and
  file lock do not survive between two requests.

Options considered:

1. **Self-hosted machine plus tunnel** (Cloudflare Tunnel or Tailscale
   Funnel). Simple, but the user's machine must stay on, and every user
   has to run their own.
2. **One shared Netatmo app for everyone.** Simplest onboarding, but the
   app's quota is shared, Netatmo's agreement is probably needed, and one
   master secret would open every home.
3. **Users type their credentials or tokens into the chat.** Rejected:
   chat content is sent to the AI provider, kept in history and read by
   the model, and prompt injection could exfiltrate it. On a shared
   server, "overwriting the tokens" would also hand one user's home to
   the next user.
4. **Static hosting (GitHub Pages).** Rejected for the service: it cannot
   run code or keep secrets. It suits the public website.
5. **Hosted service where each user brings their own Netatmo app**,
   onboarded through the MCP OAuth flow, on Cloudflare Workers. Chosen.

## Decision

### 1. Bring your own Netatmo app, onboarded through MCP OAuth

The service is an OAuth 2.1 **authorization server and protected
resource** for MCP clients, as the MCP authorization specification
requires (protected resource metadata, authorization server metadata,
PKCE, client registration). Adding the connector **is** the registration;
there is no separate account system.

1. The user adds `https://<host>/mcp` as a connector in ChatGPT, Claude
   or another client.
2. The client is sent to the service's **authorization page**. There the
   user enters their own Netatmo client ID and secret, chooses read-only
   or read + write, and sees which client and redirect domain will get
   access.
3. The service redirects to Netatmo's authorization page with the
   matching scopes. Netatmo calls back
   `https://<host>/netatmo/callback`, which the user registered in their
   Netatmo app. The service exchanges the code server-side.
4. The service stores the Netatmo app credentials and tokens,
   encrypted, under an account key. It then completes the MCP OAuth flow
   and gives the client an access token bound to that account only.

The LLM never sees a Netatmo secret. Each user consumes **their own
app's quota**, and no master secret exists. The onboarding guide stays
close to today's (create a free Netatmo app) with one difference: the
redirect URI points to the service, not `localhost`.

**Account key.** A keyed hash (HMAC with a server secret) of the Netatmo
user identity, never the email in clear. Logging in again with the same
Netatmo account updates the same account and never creates a second one.

### 2. Platform: Cloudflare Workers, plus GitHub Pages for the site

- **Workers** runs the MCP endpoint (`createMcpHandler(...).fetch`), the
  OAuth endpoints and the onboarding pages. The free tier is expected to
  be enough for a beta; limits must be checked at implementation time.
- **One Durable Object per account** holds that account's Netatmo token
  state, refresh lock, response cache and rate limiter. This serializes
  refreshes, which replaces today's file lock. Netatmo rotates refresh
  tokens, so concurrent refreshes would lock the user out.
- **Durable storage** (D1 or KV) holds MCP OAuth clients and grants, and
  encrypted account records.
- **Secrets** (encryption key, HMAC key) live in Workers secrets, never
  in the repository.
- **GitHub Pages** hosts the public site: setup guide, privacy policy,
  legal notice, status.
- A ready-made Workers OAuth provider library may cover the OAuth server
  part. It is evaluated during the spike (§6) and adopted only if it fits
  this design and its security properties are understood.

### 3. Encryption and data minimisation

- Netatmo client secrets and tokens are encrypted at rest with AES-GCM
  (WebCrypto) under a server key, and stored only as ciphertext.
- Stored per account: account key, encrypted Netatmo app credentials and
  tokens, granted scopes, write-mode choice and limits, creation and last
  use dates, and a write audit log.
- **No heating data is stored** beyond short-lived caches (the same
  topology and status TTLs as today). No email, coordinates or address.
- **Deletion.** A "delete my account" page, and an MCP tool that only
  returns its link. Deletion removes every record for the account at
  once. Accounts inactive for 12 months are deleted.

### 4. Confirmations in a stateless server

Confirmation tokens and the 2026-07-28 `requestState` become
**self-contained and authenticated**. They are AEAD-sealed by the server
and carry:

- the account key,
- the confirmation key: tool, arguments and request digest, as today,
- the preview time (ADR-0012 fix for `duration_minutes`),
- the expiry.

**Single use** is enforced by recording each token's nonce in the
account's Durable Object until the token expires. Everything else in
ADR-0012 applies unchanged: limits, no write retries, audit log. The
`NETATMO_MCP_CONFIRM` modes become a per-account setting.

### 5. Security requirements before any public user

- **Consent page.** Show the requesting client's name, its redirect URI
  **domain**, and the scopes, read-only or write. A malicious client can
  register under the name "ChatGPT", so the domain is what the user must
  check.
- **Client registration.** Only exact redirect URIs. HTTPS only, except
  loopback for local tools. Rate-limit registrations.
- **OAuth flow.** PKCE required. `state` bound to the browser session.
  CSRF protection on every form. Authorization codes single-use and
  short-lived.
- **MCP tokens.** Short-lived access tokens with refresh tokens, audience
  bound to `https://<host>/mcp`, and revocable from the account page.
- **Requests.** Validate `Origin` and `Host` (the SDK's validation
  helpers). Cap body size. Rate-limit per account and per IP.
- **Logs.** Never log secrets, tokens or Netatmo identifiers; the
  existing redaction stays in force. No third-party analytics.
- **Release gate.** An independent security review is required before
  inviting users, then again before any public opening.

### 6. Stages

| Stage                         | Scope                                                                                                                                   | Exit criteria                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Spike**                     | Worker with `createMcpHandler`, one read tool, stub OAuth. Connect from ChatGPT and Claude, on the web and on mobile.                   | Both clients complete OAuth and call a tool. Platform limits confirmed. |
| **0.3: single-tenant remote** | Full design, locked to one Netatmo account (allow-list). Anyone can deploy their own copy to their own Cloudflare account with a guide. | The maintainer uses it daily from a phone. Security review passed.      |
| **0.4: hosted beta**          | The maintainer's deployment opens to invited users, capped at a few dozen. Privacy policy and deletion are live.                        | No security finding open. Netatmo informed.                             |
| **Public**                    | Open registration.                                                                                                                      | Beta feedback. Netatmo's position known. Cost and support sustainable.  |

The local stdio server stays fully supported and remains the
recommended option for clients that can run it.

### 7. Code structure

- **Core** (Netatmo client, domain, analytics, MCP tool registration)
  becomes runtime-neutral. It must not import Node-only modules
  (`node:fs`, `node:os`, child processes). It already takes `fetch`, a
  clock and a token provider through its constructors.
- **`src/local`**: today's CLI, stdio transport, file credential store
  and file lock. Node only.
- **`src/remote`**: the Worker entry, OAuth, onboarding pages, Durable
  Object, encrypted storage and sealed confirmation tokens.
- Tests run the core against both token providers. Remote tests use the
  Workers test runtime.

## Consequences

- **Supersedes the stdio-only part of ADR-0002** for the remote mode
  only. The non-goal "cloud-hosted or multi-tenant server" in the
  roadmap is revised.
- The maintainer becomes the **operator** of a service that stores
  credentials giving access to other people's homes. Under GDPR they are
  the data controller. A privacy policy, legal notice, deletion procedure
  and incident plan are required before the beta. The disclaimer must
  say that heating safety must not depend on the service.
- **Netatmo.** With bring-your-own-app, each user acts under their own
  developer app, which avoids the shared-quota problem. Netatmo's terms
  for a third-party hosted service, and the use of its name, must still
  be checked. The maintainer should contact Netatmo before the public
  stage.
- **Costs and operations.** A domain, and possibly Cloudflare paid
  features beyond the free tier. Monitoring, dependency updates and
  incident response become ongoing work.
- **Onboarding is heavier than ChatGPT's built-in connectors**: users
  still create a Netatmo developer app. A shared-app mode (option 2)
  could be reconsidered later if Netatmo grants a partnership and quota.
- **Remote clients will mostly confirm through the preview + token
  flow.** Its limitation (ADR-0012: it cannot prove a human agreed)
  matters more for a service open to many users. Write mode stays opt-in
  per account, with the same limits.
- **Spike result (2026-10-09):** ChatGPT (desktop and mobile) and Claude
  (web, desktop and mobile) both registered with Client ID Metadata
  Documents, completed OAuth and called a tool. Details and findings:
  [spike/remote-worker/README.md](../../spike/remote-worker/README.md#results-2026-10-09).
- **Open questions left for 0.3:**
  - Durable Object and storage limits on the free tier.
  - Whether Netatmo accepts the service's callback URL in user-created
    apps.
