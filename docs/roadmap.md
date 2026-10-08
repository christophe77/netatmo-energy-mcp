# Roadmap

This roadmap is a statement of intent, not a commitment. Versions follow
[Semantic Versioning](https://semver.org/). Before 1.0, minor versions
may contain breaking changes, and each one is documented in the
changelog.

## v0.1: Read-only Netatmo Energy MCP

Focus: reliable data access.

- OAuth2 login with a local callback (`login`, `logout`, `status`, `doctor`, `serve`)
- Safe token storage and rotation-aware refresh
- Discovery of homes, rooms and devices
- Current status: temperatures, setpoints, modes, heating demand, boiler on/off, battery and signal
- History: room temperature, setpoint, boiler activity (thermostat installations)
- Basic deterministic analytics: summary, room comparison, anomaly detection
- MCP resources and prompts
- Documentation in English and French; config examples for Claude Desktop, Claude Code and Cursor

## v0.2: Historical analytics and richer diagnostics

- Heating cycle detection from boiler activity (cycle count, average length)
- Warm-up and cool-down rates per room (°C/h), with the uncertainty stated
- Schedule awareness: compare actual temperatures with the scheduled zones from `homesdata`
- Device health report: battery trends, unreachable modules, RF signal
- Optional CSV/JSON export of history to a local file
- Live-API findings folded back into [api-capabilities.md](api-capabilities.md)

## v0.3: Weather integration (Open-Meteo)

- Outdoor temperature from Open-Meteo for the home's location. This is opt-in, because it sends approximate coordinates to a third party.
- Degree-day normalisation of boiler activity
- "Was it colder outside?" context in reports

## v0.4: Thermal behaviour modelling

- Per-room heat-loss coefficient estimates from cool-down curves and outdoor temperature
- Insulation comparisons between rooms, reported with confidence intervals

## v0.5: Heating predictions

- Time-to-target estimates per room
- Next-day boiler activity estimates from weather forecasts

## v0.6: Thermal digital twin integration

- Export a room/thermal model that external digital-twin tools can consume
- Integration points with the sibling *Thermal Twin* project

## v1.0: Stable public interface

- Stable tool names, input/output schemas and resource URIs
- Documented deprecation policy
- Optional, explicitly opted-in write operations (setpoints/modes), behind a separate scope, a configuration flag and per-call confirmation. These are **not** planned before the read-only surface is stable.

## Considered, not planned

- A cloud-hosted or multi-tenant server
- Calling an LLM from the server
- A web dashboard
