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
