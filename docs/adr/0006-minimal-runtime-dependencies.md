# ADR-0006: Minimal runtime dependencies

Status: Proposed
Date: 2026-10-08

## Context

The package handles OAuth secrets and is meant to run via `npx`. Every
runtime dependency adds supply-chain risk, install time and maintenance.
Node ≥ 22 provides `fetch`, `AbortSignal.timeout`, `util.parseArgs`,
`crypto.randomBytes`/`timingSafeEqual`, `Intl` time-zone support and
`readline/promises`.

## Decision

Runtime dependencies are limited to `@modelcontextprotocol/server` and
`zod`. Everything else is built in-house on Node built-ins:

| Need | Implementation |
|---|---|
| HTTP | `fetch` |
| CLI args | `util.parseArgs` |
| Prompts in `login` | `readline/promises` (secret input not echoed) |
| Opening the browser | `child_process.spawn` (`cmd /c start`, `open`, `xdg-open`) |
| Logging | ~50-line stderr logger with level filter and key-based redaction |
| Time zones | `Intl.DateTimeFormat` |
| Config dir | ~20-line resolver (`APPDATA`, `XDG_CONFIG_HOME`, macOS path) |

Adding a runtime dependency requires a short justification in the PR.

## Consequences

- Small install, small attack surface, easy auditing.
- We maintain a few small utilities ourselves, each covered by unit
  tests.
