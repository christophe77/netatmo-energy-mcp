# ADR-0011: Extension point for a future snapshot collector

Status: Accepted (2026-10-08). The collector itself is deferred and not
part of v0.1.
Date: 2026-10-08

## Context

The Thermal Twin project will need historical `heating_power_request`
(room heating demand) and boiler-status series. Netatmo only exposes
these as current values in `homestatus`. The only way to obtain a
history is to poll `homestatus` periodically and store the snapshots
locally. Room temperature and setpoint snapshots would also be useful,
because they are finer-grained and more immediate than `getroommeasure`
buckets.

## Decision

v0.1 does **not** ship a collector. It does put three seams in place, so
that a collector can be added later without refactoring:

1. **`HomeSnapshot` domain type.** `homestatus` is normalised into a
   timestamped, self-describing snapshot:

   | Part        | Fields                                                                         |
   | ----------- | ------------------------------------------------------------------------------ |
   | Snapshot    | `observedAt`, `homeId`                                                         |
   | Each room   | temperature, setpoint, setpoint mode, heating demand %, open window, reachable |
   | Each module | type, boiler status, battery, signal, reachable                                |

   The MCP status tools use it. The collector would persist the same
   type.

2. **The `NetatmoClient` interface and the rate limiter are shared
   services.** The limiter takes its budget as configuration. A
   collector would get a separate, smaller budget so it can never starve
   interactive use.
3. **Injectable `Clock`.** Time is read through a `Clock`
   (`now(): number`), which keeps scheduling and gap detection testable.

The intended future shape, documented here and not implemented:

- A separate CLI command, `netatmo-energy-mcp collect`, which is opt-in
  and runs as a long-lived process or an OS-scheduled task. The MCP
  server never polls in the background, because MCP clients start and
  stop servers unpredictably.
- A configurable interval, 5 min by default with a 2 min minimum, plus
  jitter. It is rate-limit aware: one `homestatus` call per home per
  tick, about 12 requests per hour per home.
- A `SnapshotStore` interface. The first adapter would be an
  append-only local store: JSON Lines per month, or `node:sqlite` once
  it is stable on all supported Node versions. Data stays under the
  config/data directory.
- Missing-data detection from expected and actual tick timestamps.
- History tools would gain an optional `source: "collector"` for series
  that Netatmo does not provide. Results would always be labelled as
  locally collected snapshots, not Netatmo measurements.

## Consequences

- v0.1 stays small and stateless apart from credentials.
- Adding the collector later means adding a command, a store adapter and
  optional tool parameters. No existing layer has to be reworked.
- Concurrent MCP processes and a collector share one per-user Netatmo
  quota. A future cross-process rate budget may be needed, and that
  question is recorded here.
