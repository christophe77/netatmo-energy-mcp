# ADR-0008: MCP tool surface and error model

Status: Accepted (2026-10-08)
Date: 2026-10-08

## Context

The brief lists 18 tools. Models choose tools less reliably as the tool
list grows, and every tool definition costs context in every
conversation. Some requested tools are backed by the same API data, and
one, heating-demand history, has no data source at all: Netatmo exposes
`heating_power_request` only as a current value.

## Decision

- Ship **14 tools**, all prefixed `netatmo_`, all annotated
  `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`
  and `openWorldHint: true`.
- Merge `get_room_temperature` and `get_room_setpoint` into
  **`netatmo_get_room_status`**. Both come from one `homestatus` row.
- **Do not register** `netatmo_get_heating_demand_history`. The
  limitation is documented in the README and in
  [api-capabilities.md](../api-capabilities.md). Current demand is
  available through `netatmo_get_heating_status`.
- Tools that are valid in general but cannot work for a given
  installation return `UNSUPPORTED_CAPABILITY`. For example, boiler
  history fails on a valve-only home with no thermostat. They never
  substitute other data.
- Every tool has a Zod `inputSchema` and an object-root `outputSchema`,
  and returns both `structuredContent` and a JSON text block.
- Errors are returned as `isError: true` results with a body of the form
  `{ code, message, hint }`. `code` is one of `AUTH_REQUIRED`,
  `PERMISSION_DENIED`, `RATE_LIMITED`, `NOT_FOUND`, `INVALID_ARGUMENT`,
  `UNSUPPORTED_CAPABILITY`, `NETATMO_UNAVAILABLE` or `INVALID_RESPONSE`.
- Resource and prompt handlers throw `ProtocolError` (or
  `ResourceNotFoundError`), as the SDK expects.

## Consequences

- Tool selection stays clear, and the tool list fits comfortably in
  context.
- Some names differ from the brief. The README maps common questions to
  tools.
- If Netatmo adds a demand-history measure, the tool can be added
  without breaking anything.
