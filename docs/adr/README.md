# Architecture Decision Records

Each ADR records one significant decision: its context, the decision
itself and its consequences. ADRs are not rewritten after the fact. A
decision is changed by writing a new ADR that supersedes the old one.

| #                                                 | Title                                           | Status                                      |
| ------------------------------------------------- | ----------------------------------------------- | ------------------------------------------- |
| [0001](0001-typescript-mcp-sdk-v2.md)             | TypeScript, MCP SDK v2 and the toolchain        | Accepted                                    |
| [0002](0002-read-only-stdio-only.md)              | Read-only, stdio-only v0.1                      | Accepted; read-only part superseded by 0012 |
| [0003](0003-oauth-authorization-code-loopback.md) | OAuth authorization code with loopback callback | Accepted                                    |
| [0004](0004-bring-your-own-netatmo-app.md)        | Users bring their own Netatmo developer app     | Accepted                                    |
| [0005](0005-token-storage-and-refresh.md)         | Token storage and rotation-safe refresh         | Accepted                                    |
| [0006](0006-minimal-runtime-dependencies.md)      | Minimal runtime dependencies                    | Accepted                                    |
| [0007](0007-bounded-history-retrieval.md)         | Bounded, chunked history retrieval              | Accepted                                    |
| [0008](0008-tool-surface.md)                      | MCP tool surface and error model                | Accepted                                    |
| [0009](0009-honest-analytics.md)                  | Deterministic analytics and honest semantics    | Accepted                                    |
| [0010](0010-time-handling.md)                     | Time handling                                   | Accepted                                    |
| [0011](0011-future-snapshot-collector.md)         | Extension point for a future snapshot collector | Accepted (collector deferred)               |
| [0012](0012-opt-in-write-mode.md)                 | Opt-in write mode with user confirmation        | Accepted                                    |
| [0013](0013-remote-hosted-service.md)             | Remote access and a hosted multi-user service   | Accepted                                    |

Template:

```md
# ADR-NNNN: Title

Status: Proposed | Accepted | Superseded by ADR-XXXX
Date: YYYY-MM-DD

## Context

## Decision

## Consequences
```
