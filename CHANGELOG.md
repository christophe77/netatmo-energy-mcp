# Changelog

All notable changes to this project are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/). Before 1.0,
minor versions may contain breaking changes; they are always listed.

## [Unreleased]

## [0.2.0] - 2026-10-08

Schedules and opt-in heating control. Read-only remains the default:
nothing changes for existing users unless they run `login --write`.

### Added

- **Weekly schedules:** `netatmo_get_schedules` shows each schedule's
  zones, the setpoint of every room per zone, away and frost-guard
  temperatures, and the timetable as day + time + zone.
- **Opt-in write mode** ([ADR-0012](docs/adr/0012-opt-in-write-mode.md)),
  off by default. `login --write` also requests the `write_thermostat`
  scope; the heating-control tools are registered only then:
  - `netatmo_set_room_setpoint`: temporary manual setpoint or boost (always
    with an end time), or back to the schedule.
  - `netatmo_set_home_mode`: schedule, away or frost guard, optionally
    until a date.
  - `netatmo_switch_schedule`, `netatmo_create_schedule`,
    `netatmo_update_schedule`.
  - `netatmo_rename_schedule` and choosing a schedule in
    `netatmo_set_home_mode` (experimental: undocumented Netatmo
    parameters).
- Every change is previewed and needs the user's confirmation: MCP
  elicitation when the client supports it (2025 and 2026-07-28 protocol
  versions), otherwise a single-use confirmation token bound to the exact
  arguments and to the exact request to send. `NETATMO_MCP_CONFIRM=elicitation`
  accepts only confirmations shown by the client; `token` skips the client
  dialog for clients that advertise it without showing it. Cancellations
  report what the client answered (`client_answer`).
- Limits: `NETATMO_MCP_MIN_TEMP` / `NETATMO_MCP_MAX_TEMP` (7–28 °C by
  default), `NETATMO_MCP_MAX_SETPOINT_HOURS` (24 h by default; manual
  setpoints last 3 h unless told otherwise). `NETATMO_MCP_WRITE=0` forces
  read-only mode.
- Local audit log of applied and failed changes: `changes.log` in the
  configuration folder.
- `status` and `doctor` report whether write mode is active.
- Changes are always planned from fresh Netatmo data, and schedules that
  Netatmo reports incompletely are refused rather than sent back partially.

### Changed

- The server is served with the SDK's `serveStdio`, which negotiates both
  the 2025 `initialize` handshake and the 2026-07-28 protocol version.
- Write requests are never retried automatically. After a network error
  or a 5xx response, the result says the change may or may not have been
  applied, and `changes.log` records the outcome as `unknown`.
- A token refresh without a `scope` field keeps the scope granted at
  login.
- `docs/tools.md` now documents the write-mode tools.

### Documentation

- Compatibility with any local (stdio) MCP client and model, not just
  Claude: setup verified against official docs for VS Code + GitHub
  Copilot, Copilot CLI, Codex CLI, Gemini CLI, Windsurf / Devin Desktop,
  Zed, Cline, Roo Code, Kilo Code, Continue, JetBrains AI Assistant, Kiro,
  Warp, LM Studio, Goose, LibreChat, AnythingLLM, Msty and Open WebUI
  (via mcpo). Remote-only assistants (ChatGPT, Claude.ai web, Le Chat)
  are listed as not compatible.

## [0.1.0] - 2026-10-08

First public version: a read-only MCP server for Netatmo Energy.

### Added

- **Authentication**
  - OAuth2 authorization code login (`login`), with a loopback callback
    or `--manual` paste.
  - Only the `read_thermostat` scope is requested.
  - Credential storage in the per-user config folder: owner-only
    permissions (POSIX modes, Windows ACL) and atomic writes.
  - Rotation-safe token refresh, coordinated across processes.
  - `logout`, `status` and `doctor` commands.
- **Netatmo client**
  - Read-only client for `homesdata`, `homestatus`, `getroommeasure`
    and `getmeasure`.
  - Timeouts and cancellation, retries with backoff and `Retry-After`.
  - Error classification, a client-side rate limiter, lenient schema
    validation and caching.
- **History**
  - Paging beyond 1024 values, gap detection (never interpolated) and
    time zone handling, including DST.
- **MCP tools: 14, all read-only**
  - Discovery: `netatmo_list_homes`, `netatmo_get_home`,
    `netatmo_list_rooms`, `netatmo_list_devices`.
  - Status: `netatmo_get_home_status`, `netatmo_get_room_status`,
    `netatmo_get_heating_status`, `netatmo_get_device_status`.
  - History: `netatmo_get_temperature_history`,
    `netatmo_get_setpoint_history`, `netatmo_get_boiler_history`.
  - Analytics: `netatmo_get_heating_summary`, `netatmo_compare_rooms`,
    `netatmo_detect_anomalies`.
- **MCP resources** `netatmo://homes` and per-home `rooms`, `devices`
  and `status`.
- **MCP prompts** `heating_daily_report`, `heating_anomaly_review`,
  `room_comparison` and `heating_efficiency_review`.
- **Deterministic heating analytics**
  - Time below/within/above target, largest drop, cool-down rate and
    room rankings.
  - Rule-based anomalies, each with severity, confidence and evidence.
- **`probe` command:** sanitized API responses and a validation report,
  for device compatibility reports.
- **Documentation:** English and French READMEs, client configuration
  examples, a generated tool reference, ADRs, an API capability matrix
  and a security review.

### Notes

- Boiler activity is reported as heat-**demand** time. Netatmo documents
  these measures in minutes, but live data shows seconds; they are
  converted.
- No energy or gas consumption is reported: the Netatmo Energy API does
  not provide it.
- Tested on Netatmo Smart Thermostat (`NATherm1`), Smart Radiator Valves
  (`NRV`) and Relay (`NAPlug`). OpenTherm devices are untested.

[Unreleased]: https://github.com/christophe77/netatmo-energy-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/christophe77/netatmo-energy-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/christophe77/netatmo-energy-mcp/releases/tag/v0.1.0
