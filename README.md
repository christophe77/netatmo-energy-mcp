# Netatmo Energy MCP

A read-only [Model Context Protocol](https://modelcontextprotocol.io)
server for **Netatmo smart thermostats and smart radiator valves**. It
lets AI assistants such as Claude Desktop, Claude Code and Cursor read
your heating data: room temperatures, setpoints, boiler activity and
heating history. It runs locally and can't change your heating
settings.

> **Status: early development, not usable yet.**
> The project design is complete, and the authentication and Netatmo
> API client are under construction. **No MCP server is available yet**,
> and nothing has been published to npm. Watch the repository or see
> [Development status](#development-status) to follow progress.

## Why this project?

Netatmo Energy installations record useful heating data: per-room
temperatures, setpoints, valve heating demand and boiler activity. That
data sits behind the Netatmo app and the Netatmo Energy API, where an
AI assistant can't reach it.

This project is a small local bridge between the Netatmo Energy API and
any MCP-compatible assistant, so that you can ask questions such as:

- "What's the temperature in the bedroom, and is it at its target?"
- "How many minutes did the boiler run yesterday?"
- "Compare my rooms over the last week."
- "Did anything unusual happen with the heating last night?"

No existing Netatmo MCP server covers thermostats, radiator valves and
heating history. The few that exist focus on Netatmo weather stations.
See [docs/research.md](docs/research.md) for the comparison.

## Planned features (v0.1)

- **Discovery:** homes, rooms, thermostats, radiator valves, relays
- **Current status:** room temperature and setpoint, heating mode,
  valve heating demand, boiler on/off, battery and signal levels
- **History:** room temperature and setpoint history, boiler activity
  history (thermostat installations). Long ranges are fetched in chunks
  and summarised so that responses stay small.
- **Analytics:** deterministic statistics, time below and above target,
  room comparison and basic anomaly detection. No LLM calls are involved.
- **MCP resources and prompts** for daily reports and anomaly reviews
- **CLI:** `login`, `logout`, `status`, `doctor`, `serve`

Planned tools and their data sources are listed in
[docs/architecture.md](docs/architecture.md#9-mcp-surface). The
[roadmap](docs/roadmap.md) covers later work: weather context, thermal
modelling and predictions.

**This project will not report gas or energy consumption.** The Netatmo
Energy API does not measure it. Boiler "on" minutes show when the
thermostat requested heat, which is not the same as gas burned. Every
limitation found so far is documented in
[docs/api-capabilities.md](docs/api-capabilities.md).

## Security approach

- **Read-only by design.** The server requests only the
  `read_thermostat` OAuth scope. The code has no path to Netatmo's write
  endpoints, and a test fails if one is added.
- **Local only.** The server talks to your assistant over stdio and
  opens no network port. It contacts only `api.netatmo.com`, and it sends
  no telemetry.
- **OAuth2, never your password.** You sign in on netatmo.com. Tokens
  are stored in your user configuration directory with restricted
  permissions. Netatmo's rotating refresh tokens are handled safely when
  several assistants run at the same time.
- **Your own Netatmo app.** Each user registers a free Netatmo developer
  app. No shared secret and no intermediary server are involved.

Design decisions are recorded as [ADRs](docs/adr/README.md).

## Development status

| Phase | Scope | Status |
|---|---|---|
| 0 | Research, architecture, ADRs | Done |
| 1 | Project foundation (TypeScript, tests, config) | In progress |
| 2 | OAuth2 login and token storage | Planned |
| 3 | Netatmo API client | Planned |
| — | Live API validation on a real installation | Planned |
| 4 | MCP tools, resources and prompts | Planned |
| 5 | Heating analytics | Planned |
| 6–8 | Quality, documentation, release preparation | Planned |

The first release will be **v0.1.0**. It will be announced in this
repository's Releases once it has been tested against a real Netatmo
installation.

## Following development

- **Watch** the repository (Custom → Releases) to be notified of the
  first release.
- Ask questions and share your device setup in
  [Discussions](https://github.com/christophe77/netatmo-energy-mcp/discussions).
- Read the [architecture](docs/architecture.md) and the
  [API capability matrix](docs/api-capabilities.md).

A French translation (`README.fr.md`) will accompany the first release.

## License

[Apache-2.0](LICENSE)

## Disclaimer

This is an independent open-source project. It is not affiliated with,
endorsed by or sponsored by Netatmo or Legrand. "Netatmo" is a trademark
of its owner and is used here only to describe compatibility.
