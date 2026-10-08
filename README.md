<img src="docs/assets/logo.svg" alt="" width="72" align="right">

# Netatmo Energy MCP

**English** | [Français](README.fr.md)

[![CI](https://github.com/christophe77/netatmo-energy-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/christophe77/netatmo-energy-mcp/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node.js >= 22.19](https://img.shields.io/badge/node-%3E%3D22.19-339933)

A read-only **Netatmo MCP server** for **Netatmo smart thermostats and
smart radiator valves**. It gives AI assistants structured access to
your heating:

- room temperatures and setpoints
- heating demand and boiler activity
- temperature history
- deterministic heating analytics

It runs on your machine, talks only to the official **Netatmo Energy API**,
and cannot change any heating setting.

It works with any [Model Context Protocol](https://modelcontextprotocol.io)
client that runs local servers, **whatever the model**:

- **Claude**: Claude Desktop, Claude Code
- **GPT / OpenAI**: Codex CLI, VS Code + GitHub Copilot, Cursor
- **Gemini**: Gemini CLI, VS Code + GitHub Copilot
- **Mistral and others** through multi-model clients
- **Local LLMs** (Llama, Qwen, Mistral, DeepSeek, …): LM Studio, and
  Ollama via Goose, Continue, Cline, AnythingLLM, LibreChat or Open WebUI

It also works in Windsurf / Devin Desktop, Zed, Roo Code, Kilo Code,
JetBrains AI Assistant, Kiro and Warp. See
[all compatible clients](#compatible-ai-assistants-and-mcp-clients).

> **Status: early release (0.1.0).** The Netatmo API integration has been
> validated on a real installation; feedback and device reports are welcome.

## Why this project?

A Netatmo heating system records useful data:

- the temperature and setpoint of every room
- what each radiator valve is asking for
- when the boiler is asked to heat

That data is locked in the Netatmo app, where you can look at it but not
ask questions about it.

This project is a small bridge between the Netatmo Energy API and any
MCP-compatible AI assistant. Ask in plain language: "Which room was
coldest last night?" The assistant calls a precise, read-only tool and
answers from your data. It doesn't guess.

The few other Netatmo MCP servers target Netatmo **weather stations**.
This one is built for **thermostats, radiator valves and heating history**.
See [docs/research.md](docs/research.md) for the comparison.

## Features

- **Discovery:** homes, rooms, thermostats, smart radiator valves, relays
  and gateways.
- **Current status**
  - Per room: temperature, setpoint, setpoint mode and heating demand.
  - Boiler on/off and open-window detection.
  - Device health: battery, radio/Wi-Fi signal, reachability.
- **History**
  - Room temperature and setpoint history at 30 min to 1 month
    resolution.
  - Boiler activity history (installations with a Netatmo thermostat).
  - Long ranges are fetched in chunks and summarised, so answers stay
    small.
  - Gaps are reported, never filled in.
- **Heating analytics.** These are deterministic calculations; no AI
  model computes the numbers.
  - Per-room statistics.
  - Time below, within or above the setpoint.
  - Largest temperature drop and cool-down rates.
  - Room rankings.
  - Rule-based detection of unusual readings, each with severity and
    confidence.
- **14 MCP tools, 4 resources and 4 prompts** (daily report, anomaly
  review, room comparison, heating pattern review).
- **Simple setup**
  - OAuth2 browser login with a single `login` command.
  - Tokens stored securely and refreshed automatically.
  - `doctor` checks your setup.

## Quick start

You need Node.js 22.19 or later and a Netatmo account with Energy devices.

### 1. Create a free Netatmo developer app

1. At <https://dev.netatmo.com/apps>, choose **Create**.
2. Set the **redirect URI** to `http://localhost:8977/callback`.
3. Keep the **client ID** and **client secret** for step 2.

Step-by-step guide: [docs/authentication.md](docs/authentication.md).

### 2. Log in

```bash
npx -y netatmo-energy-mcp login
```

`login` asks for the client ID and secret, then opens your browser so you
can sign in on netatmo.com and approve **read-only** access. Then check
the setup:

```bash
npx -y netatmo-energy-mcp doctor
```

> **Running from source instead:** clone the repository, run
> `pnpm install && pnpm build`, then use
> `node /path/to/netatmo-energy-mcp/dist/index.js` in place of
> `npx -y netatmo-energy-mcp`.

### 3. Connect your AI assistant

Most clients use the same `mcpServers` JSON block. This works for Claude
Desktop, Cursor, Windsurf / Devin Desktop, Cline, Roo Code, Kiro,
LM Studio, JetBrains AI Assistant, AnythingLLM, Warp and Gemini CLI:

```json
{
  "mcpServers": {
    "netatmo-energy": {
      "command": "npx",
      "args": ["-y", "netatmo-energy-mcp"]
    }
  }
}
```

Command-line clients:

```bash
# Claude Code
claude mcp add --transport stdio --scope user netatmo-energy -- npx -y netatmo-energy-mcp
# OpenAI Codex CLI
codex mcp add netatmo-energy -- npx -y netatmo-energy-mcp
# GitHub Copilot CLI
copilot mcp add netatmo-energy -- npx -y netatmo-energy-mcp
```

**VS Code + GitHub Copilot.** Add this to `.vscode/mcp.json`; note the
`servers` key:

```json
{
  "servers": {
    "netatmo-energy": { "type": "stdio", "command": "npx", "args": ["-y", "netatmo-energy-mcp"] }
  }
}
```

No secrets go in any of these files: `login` stored them in your user
configuration folder. File locations for each client, plus Zed,
Continue, Goose, LibreChat, Kilo Code, Msty and Open WebUI, are in
[examples/](examples/README.md).

### 4. Ask

> "What's the temperature in each room right now?"

## Example questions

These are the kinds of questions the tools are built for. The assistant
chooses the tools; the table shows which ones answer each question.

| Question                                                             | Tools used                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------- |
| "What's the temperature in my bedroom, and is it at its target?"     | `netatmo_get_room_status`                                     |
| "Is the boiler running right now? Which rooms are asking for heat?"  | `netatmo_get_heating_status`                                  |
| "How long did my boiler run yesterday?"                              | `netatmo_get_boiler_history`                                  |
| "Show the living room temperature for the last 7 days."              | `netatmo_get_temperature_history`                             |
| "Compare my rooms over the last week. Which one cools down fastest?" | `netatmo_compare_rooms`                                       |
| "Did my heating behave unusually last night?"                        | `netatmo_detect_anomalies`                                    |
| "Give me yesterday's heating report."                                | prompt `heating_daily_report` → `netatmo_get_heating_summary` |
| "Are any valve batteries low?"                                       | `netatmo_get_device_status`                                   |

Boiler "run time" is the time the thermostat **requested heat**. Netatmo
does not measure gas or energy consumption, so this project never reports
it.

## Available MCP tools

All tools are read-only and need only the `read_thermostat` OAuth scope.
The full reference, with arguments and outputs, is generated from the
server itself: [docs/tools.md](docs/tools.md).

| Tool                              | Description                                             |
| --------------------------------- | ------------------------------------------------------- |
| `netatmo_list_homes`              | Homes with Energy devices, room/device counts           |
| `netatmo_get_home`                | Home details: heating mode, schedules, rooms, devices   |
| `netatmo_list_rooms`              | Rooms with IDs, types and devices                       |
| `netatmo_list_devices`            | Thermostats, valves, relays: model, room, gateway       |
| `netatmo_get_home_status`         | Current status of every room, boiler state, alerts      |
| `netatmo_get_room_status`         | Current temperature and setpoint of one room            |
| `netatmo_get_heating_status`      | Boiler on/off, rooms requesting heat                    |
| `netatmo_get_device_status`       | Battery, signal, reachability, firmware                 |
| `netatmo_get_temperature_history` | Room temperature history with statistics and gaps       |
| `netatmo_get_setpoint_history`    | Room setpoint history and setpoint periods              |
| `netatmo_get_boiler_history`      | Boiler heat-demand time per hour/day/week               |
| `netatmo_get_heating_summary`     | Per-room comfort metrics plus boiler time over a period |
| `netatmo_compare_rooms`           | Room metrics and rankings                               |
| `netatmo_detect_anomalies`        | Unusual readings with severity, confidence and evidence |

Resources: `netatmo://homes` and `netatmo://homes/{homeId}/rooms`,
`…/devices` and `…/status`.

## Supported devices

| Device                                    | Netatmo type  | Status                                                           |
| ----------------------------------------- | ------------- | ---------------------------------------------------------------- |
| Smart Thermostat                          | `NATherm1`    | **Tested.** API validated on a live installation (2026-10-08)    |
| Smart Radiator Valve                      | `NRV`         | **Tested.** Same installation (6 valves)                         |
| Thermostat Relay                          | `NAPlug`      | **Tested.** Same installation                                    |
| OpenTherm Modulating Thermostat / Gateway | `OTM` / `OTH` | Expected to work, **untested**                                   |
| BTicino Smarther with Netatmo             | `BNS`         | Not supported in v0.1 (probably needs the `read_smarther` scope) |

Run `netatmo-energy-mcp probe` and open a
[device compatibility report](https://github.com/christophe77/netatmo-energy-mcp/issues/new?template=device_compatibility.yml)
to help extend this table. The probe output is sanitized.

## Compatible AI assistants and MCP clients

This is a standard **local (stdio) MCP server**, so it is not tied to one
AI vendor. Any MCP client that can start local servers can use it, with
whatever model that client runs.

| Client                                                                    | Models                                                   |
| ------------------------------------------------------------------------- | -------------------------------------------------------- |
| Claude Desktop, Claude Code                                               | Claude                                                   |
| OpenAI Codex CLI                                                          | OpenAI GPT models                                        |
| Gemini CLI                                                                | Google Gemini                                            |
| VS Code + GitHub Copilot (agent mode), GitHub Copilot CLI                 | GPT, Claude, Gemini and other Copilot models             |
| Cursor, Windsurf / Devin Desktop, Zed, Warp, Kiro, JetBrains AI Assistant | multiple hosted models                                   |
| Cline, Roo Code, Kilo Code, Continue                                      | multiple, including local models (Ollama, LM Studio)     |
| LM Studio                                                                 | **local open models**: Llama, Qwen, Mistral, DeepSeek, … |
| Goose, AnythingLLM, LibreChat, Msty Studio                                | many providers, including **Ollama**                     |
| Open WebUI                                                                | Ollama and others, through the `mcpo` proxy              |

Configuration for each client, checked against official documentation:
[examples/](examples/README.md).

**Not compatible:** assistants that only accept _remote_ MCP servers
(ChatGPT apps/connectors, Claude.ai on the web, Mistral Le Chat). This
server runs locally by design, so your credentials never leave your
machine.

**Testing.** The server is tested with the official MCP SDK client and
the MCP Inspector. Tool-calling quality with small local models varies
by model. Please report any client-specific problem.

## Authentication

This project uses Netatmo's OAuth2 authorization code flow. You sign in
on netatmo.com; your Netatmo password is never seen by this tool.

**Scope.** Only `read_thermostat` is requested. A leaked token couldn't
change your heating.

**Your own app.** Each user registers a free Netatmo developer app. The
client secret cannot be shipped in open-source code.

**Refresh.** Access tokens are refreshed automatically. Several MCP
clients running at once coordinate through a lock file, so they don't
invalidate each other's tokens.

Details: [docs/authentication.md](docs/authentication.md).

## Privacy & security

**What leaves your machine.** Only HTTPS requests to `api.netatmo.com`,
and only to 4 read endpoints. The code has no path to Netatmo's write
endpoints, and a test fails if one is added.

**What stays local.**

- Credentials live in `credentials.json` in your user configuration
  folder, readable only by your account (`0600` on macOS/Linux; a
  restricted ACL on Windows).
- No telemetry, no analytics and no third-party services.
- The server talks to your MCP client over stdio and opens no network
  port.

**Your AI provider.** Data that tools return is read by the assistant
you use, so it is processed by that model provider.

**No account data or location.** Your email and home coordinates are
never returned.

Read more:

- [Security model](docs/architecture.md#10-security-model)
- [Pre-release security review](docs/security-review.md)
- [Reporting a vulnerability](SECURITY.md)

## Architecture

![Architecture: an AI assistant talks over stdio to the local read-only server, which calls the Netatmo API](docs/assets/architecture.svg)

The Netatmo client and the analytics are independent of MCP. Design
decisions are recorded as [ADRs](docs/adr/README.md), and
[docs/architecture.md](docs/architecture.md) describes the layers.

## Limitations

These come from the Netatmo Energy API; details are in
[docs/api-capabilities.md](docs/api-capabilities.md).

- **No energy or gas consumption.** Boiler activity is heat-_demand_
  time. With aggregated data, the number of burner cycles cannot be
  known.
- **No history of valve heating demand.** It is only available as a
  current value. A future opt-in collector may record it
  ([ADR-0011](docs/adr/0011-future-snapshot-collector.md)).
- **No outdoor temperature in the Energy API.** Weather context is
  planned for v0.3.
- **History resolution is 30 minutes at best.** Each request returns at
  most 1024 values, so long ranges use coarser scales.
- **The documentation doesn't match the API in places.** Live data shows
  that boiler measures are in **seconds**, not the documented minutes.
  This project converts them.
- **Rate limits.** Netatmo limits requests per user and per app. The
  server throttles itself and caches topology and current status.

## Roadmap

| Version   | Focus                                        |
| --------- | -------------------------------------------- |
| v0.1      | Read-only MCP server (this release)          |
| v0.2      | Richer diagnostics                           |
| v0.3      | Weather context (Open-Meteo)                 |
| v0.4–v0.6 | Thermal modelling, predictions, digital twin |
| v1.0      | A stable interface                           |

Write operations will never be enabled by default.
See [docs/roadmap.md](docs/roadmap.md).

## Contributing

Bug reports, device compatibility reports and pull requests are welcome.
See [CONTRIBUTING.md](CONTRIBUTING.md) to set up the project, which runs
on mocked API responses: no Netatmo account needed. Please follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

[Apache-2.0](LICENSE)

## Disclaimer

This is an independent open-source project. It is not affiliated with,
endorsed by or sponsored by Netatmo or Legrand. "Netatmo" is a trademark
of its owner and is used here only to describe compatibility. Use at
your own risk; heating safety must never depend on an AI assistant.
