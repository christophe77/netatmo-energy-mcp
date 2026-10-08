# ADR-0004: Users bring their own Netatmo developer app

Status: Accepted (2026-10-08)
Date: 2026-10-08

## Context

Netatmo requires `client_secret` for token exchange and refresh. An
open-source, locally run tool cannot ship a shared secret: it would be
public and could be revoked or abused. A hosted token broker would
contradict the "no cloud backend" requirement. Free developer apps can be
created at dev.netatmo.com in a few minutes.

## Decision

- Each user creates their own Netatmo app and supplies `client_id` and
  `client_secret`.
- `login` reads them from the environment
  (`NETATMO_CLIENT_ID` / `NETATMO_CLIENT_SECRET`) or prompts for them.
  It then stores them with the tokens in `credentials.json` (mode
  0600). The MCP client configuration therefore needs no secrets.
- The environment overrides the stored values.

## Consequences

- There is one extra setup step. The docs give a step-by-step guide
  (app name, redirect URI, what to leave blank).
- No shared secret or central quota, and no service for the maintainer
  to run.
- With one user per app, the documented per-app burst limit (2 × users
  per 10 s) may be tight. The client's rate limiter and caching account
  for it until live tests clarify (see ADR-0007).
