# Changelog

All notable changes to this project are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/). Before 1.0,
minor versions may contain breaking changes; they are always listed.

## [Unreleased]

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

[Unreleased]: https://github.com/christophe77/netatmo-energy-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/christophe77/netatmo-energy-mcp/releases/tag/v0.1.0
