# Architecture Decision Records

Each ADR records one significant decision: its context, the decision
itself and its consequences. ADRs are not rewritten after the fact. A
decision is changed by writing a new ADR that supersedes the old one.

| # | Title | Status |
|---|---|---|
| [0001](0001-typescript-mcp-sdk-v2.md) | TypeScript, MCP SDK v2 and the toolchain | Proposed |
| [0002](0002-read-only-stdio-only.md) | Read-only, stdio-only v0.1 | Proposed |
| [0003](0003-oauth-authorization-code-loopback.md) | OAuth authorization code with loopback callback | Proposed |
| [0004](0004-bring-your-own-netatmo-app.md) | Users bring their own Netatmo developer app | Proposed |
| [0005](0005-token-storage-and-refresh.md) | Token storage and rotation-safe refresh | Proposed |
| [0006](0006-minimal-runtime-dependencies.md) | Minimal runtime dependencies | Proposed |
| [0007](0007-bounded-history-retrieval.md) | Bounded, chunked history retrieval | Proposed |
| [0008](0008-tool-surface.md) | MCP tool surface and error model | Proposed |
| [0009](0009-honest-analytics.md) | Deterministic analytics and honest semantics | Proposed |
| [0010](0010-time-handling.md) | Time handling | Proposed |

Template:

```md
# ADR-NNNN: Title
Status: Proposed | Accepted | Superseded by ADR-XXXX
Date: YYYY-MM-DD
## Context
## Decision
## Consequences
```
