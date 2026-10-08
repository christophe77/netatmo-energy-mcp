# ADR-0010: Time handling

Status: Proposed
Date: 2026-10-08

## Context

Netatmo uses Unix seconds and returns each home's IANA time zone in
`homesdata`. Bucketed measures default to `real_time=false`, which
shifts timestamps by half a step. Users ask relative questions ("yesterday",
"last night") that only make sense in the home's local time. The MCP
server may run in a different time zone from the home.

## Decision

- Internally, all instants are epoch milliseconds (UTC).
- Requests use `real_time=true`, so timestamps mark the start of each
  bucket. This is documented in tool output (`bucket: "start"`). If
  live tests show otherwise, this ADR is revised.
- Outputs use ISO 8601 with the **home's UTC offset** (for example
  `2026-01-15T07:30:00+01:00`) and include `timezone: "Europe/Paris"`.
- `period` presets (`today`, `yesterday`, `last_24h`, `last_7d`,
  `last_30d`) are resolved in the home's time zone, including DST
  transitions.
- An input ISO string without an offset is interpreted in the home's
  time zone, and one with an offset is used as is.
- Implementation uses `Intl.DateTimeFormat` with no date library.
  DST edge cases (23- and 25-hour days) have dedicated tests.

## Consequences

- Answers match what the user sees on their thermostat and in the
  Netatmo app.
- If Netatmo's "Local Unix Time" turns out not to be UTC epoch, the
  conversion is isolated in `utils/dates.ts`.
