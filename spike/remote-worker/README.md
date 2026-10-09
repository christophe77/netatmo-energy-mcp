# Remote MCP spike (ADR-0013)

A throwaway technical test: a remote MCP endpoint behind OAuth 2.1 on
Cloudflare Workers. It proves that ChatGPT and Claude (web and mobile)
can register, sign in and call a tool.

- **No Netatmo access, no user data.** The only tool, `spike_whoami`,
  reports the account and client the server sees.
- **Sign-in is a stub:** one owner password, set as a Worker secret. The
  real onboarding (bring your own Netatmo app) comes in 0.3.
- OAuth is provided by `@cloudflare/workers-oauth-provider`: discovery
  (RFC 9728 / 8414), dynamic client registration, Client ID Metadata
  Documents, PKCE, consent page, tokens stored hashed in KV.
- MCP is `createMcpHandler` from `@modelcontextprotocol/server`, which
  serves the 2025 and 2026-07-28 protocol eras statelessly.

## Run locally

```bash
npm install --ignore-scripts
```

```bash
npx wrangler dev --local
```

`.dev.vars` (not committed) must contain:

```
PUBLIC_URL=http://localhost:8787
SPIKE_PASSWORD=local-test-password-not-a-secret
```

Then, from this folder:

```bash
node e2e.mjs
```

It walks the whole flow a remote client follows (18 checks).

## Deploy to your Cloudflare account

1. Log in (opens the browser):
   ```bash
   npx wrangler login
   ```
2. Create the KV namespace and paste its `id` into `wrangler.jsonc`:
   ```bash
   npx wrangler kv namespace create OAUTH_KV
   ```
3. Deploy once to learn the URL (`https://netatmo-mcp-spike.<subdomain>.workers.dev`):
   ```bash
   npx wrangler deploy
   ```
4. Set the two secrets. Use a long random password.
   ```bash
   npx wrangler secret put PUBLIC_URL
   ```
   ```bash
   npx wrangler secret put SPIKE_PASSWORD
   ```
5. Check the deployment:
   ```bash
   SPIKE_URL=https://… SPIKE_PASSWORD=… node e2e.mjs
   ```

## Connect an assistant

Connector URL: `https://netatmo-mcp-spike.<subdomain>.workers.dev/mcp`

- **Claude** (claude.ai, then the mobile app): Settings → Connectors →
  Add custom connector.
- **ChatGPT**: Settings → Apps & Connectors → developer mode, then
  create a connector with OAuth.

On the consent page, check the client name and the destination domain,
enter the owner password and allow. Then ask: "Call spike_whoami".

## Remove

```bash
npx wrangler delete
```

Also delete the KV namespace in the Cloudflare dashboard.

## Results (2026-10-09)

Deployed to the maintainer's Cloudflare account (workers.dev). Exit
criterion of ADR-0013: met for both clients.

| Client                                  | Registration                                                                    | OAuth | Tool call         |
| --------------------------------------- | ------------------------------------------------------------------------------- | ----- | ----------------- |
| ChatGPT (desktop app and mobile)        | Client ID Metadata Document `https://chatgpt.com/oauth/client.json`             | ✅    | ✅ `spike_whoami` |
| Claude (claude.ai, desktop app, mobile) | Client ID Metadata Document `https://claude.ai/oauth/mcp-oauth-client-metadata` | ✅    | ✅ `spike_whoami` |

Findings:

- **Both clients use Client ID Metadata Documents, not dynamic
  registration.** The consent page can therefore show a _verified_ domain
  ("Published by chatgpt.com"), which is what ADR-0013 §5 relies on. DCR
  stays enabled for other clients (tested by `e2e.mjs`).
- **Bug found and fixed:** the consent page's CSP `form-action 'self'`
  made Chromium block the redirect that hands the code back to the client
  (the browser applies `form-action` to redirects after a form POST). The
  client then never exchanged its code. The page now allows the validated
  redirect origin; `e2e.mjs` checks it. Only a real browser shows this.
- **ChatGPT** listed the tools only after "Refresh" on the app page. It
  recommends an `outputSchema` on every tool (the real tools have one).
  It also probes `/.well-known/openid-configuration` (404 is fine).
- **Claude** requires approval per tool by default ("Needs approval"),
  which adds a client-side confirmation in front of write tools.
- **Library:** `@cloudflare/workers-oauth-provider` 1.2.3 covered
  discovery, CIMD, DCR, PKCE, consent helpers and token storage without
  changes. Re-check the pinned version before production.
- **Operations:** `wrangler tail` disconnected silently after about an
  hour. Use Workers Logs (observability) for the real service.
- Not covered by the spike: Netatmo onboarding, Durable Objects, sealed
  confirmation tokens, free-tier limits under load.
