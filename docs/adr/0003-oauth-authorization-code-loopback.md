# ADR-0003: OAuth authorization code with loopback callback

Status: Proposed
Date: 2026-10-08

## Context

Netatmo supports only the `authorization_code` and `refresh_token`
grants. The password grant has been removed. `client_secret` is required
for both the code exchange and refresh. PKCE is not documented anywhere:
not in the official docs, the OpenAPI spec, the developer-portal code or
any maintained library. Each app has a single registered `redirect_uri`,
which must match exactly. Whether loopback URIs are accepted is
undocumented, although community setups use them.

## Decision

- `login` runs the authorization-code flow:
  - It generates a 256-bit random `state`.
  - It starts a one-shot HTTP server on `127.0.0.1` (default port
    `8977`, path `/callback`, configurable through
    `NETATMO_REDIRECT_URI` / `--port`).
  - It opens the system browser (`start` / `open` / `xdg-open`) and also
    prints the URL.
  - It validates `state` with a constant-time comparison, exchanges the
    code and closes the server.
  - It times out after 5 minutes.
- `login --manual` is a fallback for headless machines or rejected
  loopback URIs. The user pastes the final redirected URL and `state`
  is validated the same way.
- **PKCE is not sent by default.** It is confidential-client security
  (`client_secret`) plus `state`. If live testing shows Netatmo accepts
  S256 PKCE, it will be added, because it is harmless and defence in
  depth. That needs a new ADR.
- The requested scope is `read_thermostat` only (see ADR-0002).
  `read_smarther` is added only if BNS users need it and opt in.
- The user's Netatmo password is never requested, stored or typed into
  this tool.

## Consequences

- Setup requires registering the redirect URI in the user's Netatmo
  app. The setup docs walk through this step.
- If Netatmo rejects loopback URIs, `--manual` still works and the
  default flow changes.
- The documented flow is followed. Nothing depends on undocumented
  behaviour.
