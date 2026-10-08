# ADR-0001: TypeScript, MCP SDK v2 and the toolchain

Status: Accepted (2026-10-08)
Date: 2026-10-08

## Context

The MCP TypeScript SDK reached v2 (stable) on 2026-07-27. It is split
into packages: `@modelcontextprotocol/server`, `/client` and `/core`.
The v1 line (`@modelcontextprotocol/sdk` 1.32.x) gets fixes only until at
least 2027-01. SDK v2 depends directly on `zod ^4.2`. It implements spec
revision 2026-07-28 and still negotiates the 2025 protocol versions, so
older clients keep working.

Tooling versions as of today:

- TypeScript 7.0 (the Go-native port) is GA, but typescript-eslint
  supports only `< 6.1`.
- tsup is unmaintained and points users to tsdown.
- vitest 5 and tsdown require Node ≥ 22.12 / 22.18.
- MCP Inspector v2 requires Node ≥ 22.19.
- Node 20 reached end of life in April 2026.

## Decision

- TypeScript **6.0.x**, `strict: true`, ESM only, `module: NodeNext`.
- `@modelcontextprotocol/server` **^2.3** as the runtime dependency and
  `@modelcontextprotocol/client` ^2.3 as a dev dependency for protocol
  tests.
- `zod` **^4.6**, with every schema wrapped in `z.object()`. The
  deprecated raw-shape API is not used.
- pnpm, **tsdown** (ESM, `platform: node`, shebang banner), **vitest 5**,
  ESLint 10 + typescript-eslint, Prettier.
- `engines.node: ">=22.19"`. CI tests Node 22 and 24.

## Consequences

- New project, current SDK. No migration is needed later.
- TypeScript 7 adoption waits for typescript-eslint support. `tsgo` may
  be added later as a fast extra type check.
- Users on Node 20 must upgrade. Node 20 is EOL, so this is acceptable
  and is documented.
