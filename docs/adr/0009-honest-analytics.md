# ADR-0009: Deterministic analytics and honest semantics

Status: Accepted (2026-10-08)
Date: 2026-10-08

## Context

Assistants tend to over-interpret data. Some fields are easy to
misread:

- `boileron` / `sum_boiler_on` measure minutes of boiler demand, **not**
  gas consumed.
- `heating_power_request` is a room's demand percentage, **not** boiler
  power.
- A temperature drop can have many causes.

## Decision

- All analytics are deterministic pure functions in `src/analytics/`,
  with no LLM calls and documented formulas and thresholds.
- Output field names carry their meaning, for example
  `boiler_on_minutes`, `heating_demand_percent` and `time_below_target_minutes`.
  Each analytics response includes a short `caveats` array, such as
  "Boiler on-time is relay/OpenTherm demand time, not gas consumption."
- Anomalies report observations together with `severity` and
  `confidence`. Explanations describe the data and never diagnose a
  device fault or claim a cause.
- No energy, cost or CO₂ figures are produced from data that does not
  measure them.
- Prompts instruct the assistant to separate *Observed data*, *Derived
  metrics*, *Hypotheses* and *Recommendations*.

## Consequences

- Reports are less dramatic but more trustworthy.
- Energy estimation can come later (roadmap v0.3 and beyond) only with
  explicit user-provided parameters and clear labelling.
