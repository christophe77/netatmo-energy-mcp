# ADR-0002: Read-only, stdio-only v0.1

Status: Proposed
Date: 2026-10-08

## Context

The server gives an AI assistant access to a physical heating system. A
write tool could be invoked because of a misunderstanding, a
hallucination or prompt injection. MCP tool annotations are hints that
clients are told to treat as untrusted, so they are not a safety
mechanism. Exposing an MCP server over HTTP without authentication would
also let anyone on the network read heating data.

## Decision

- v0.1 contains **no code path** that can call a Netatmo write endpoint:
  - The endpoint module is a read-only allow-list (`homesdata`,
    `homestatus`, `getroommeasure`, `getmeasure`).
  - The OAuth scope requested is `read_thermostat` only.
  - A unit test fails if any other endpoint or a `write_*` scope appears.
- The only transport is **stdio**. No HTTP server is started, except a
  short-lived loopback callback bound to `127.0.0.1` during `login`.
- No telemetry and no external calls other than `api.netatmo.com`.

## Consequences

- Users can connect the server to any assistant without risking a
  change to their heating.
- Even a stolen access token can't change the heating, because the
  token lacks the write scope.
- Remote use (one server, many clients) is out of scope until an
  authenticated HTTP transport is designed.
- Future write support needs a new ADR covering explicit opt-in, a
  separate scope and confirmation.
