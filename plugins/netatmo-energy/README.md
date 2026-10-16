# Netatmo Energy for Claude

Unofficial plugin, not affiliated with or endorsed by Netatmo.

Ask Claude about your Netatmo heating: room temperatures and setpoints,
boiler activity, heating history, room comparisons, anomalies, device
batteries and weekly schedules. If you enable write mode, Claude can also
change a room setpoint, the home mode or a schedule, each time after you
confirm the change.

## What it contains

- **MCP server** `netatmo-energy`: the open-source
  [netatmo-energy-mcp](https://github.com/christophe77/netatmo-energy-mcp)
  package, started locally with
  `npx -y netatmo-energy-mcp@<version>` (pinned to the plugin version). It
  talks to Claude over stdio and opens no network port.
- **Skill** `netatmo-energy`: which tool answers which question, how to
  investigate a cold or overheated room, report and comparison formats,
  and the preview-and-confirm steps before any heating change.

## Requirements

- Node.js 22.19 or later.
- A Netatmo account with Energy devices (thermostat or radiator valves).
- Your own free Netatmo developer app, created at
  <https://dev.netatmo.com/apps>.

Before the first use, log in once in a terminal:

```bash
npx -y netatmo-energy-mcp login
```

It asks for your app's client ID and secret and opens the Netatmo login
page. Add `--write` to allow heating changes. Without it, the server is
read-only.

## What it runs, sends and stores

- **Runs:** `npx` downloads the pinned `netatmo-energy-mcp` package from
  the npm registry and starts it on your computer.
- **Sends:** HTTPS requests to `api.netatmo.com` only, with your own
  Netatmo tokens. In read-only mode only read endpoints are called. In
  write mode a change is sent only after you confirm it.
- **Stores:** your Netatmo app credentials and tokens in
  `credentials.json` in your user configuration folder, readable only by
  your account. In write mode, `changes.log` in the same folder records
  each heating change. `npx -y netatmo-energy-mcp logout` deletes them.
- **No telemetry**, no analytics and no other service. The skill is
  instructions only and runs no code.

Data returned by the tools is read by Claude like any conversation
content. Your email address and home coordinates are never returned.

## Privacy

See the [privacy policy](https://github.com/christophe77/netatmo-energy-mcp/blob/main/PRIVACY.md).

## Support and license

Issues: <https://github.com/christophe77/netatmo-energy-mcp/issues>.
Security reports: <https://github.com/christophe77/netatmo-energy-mcp/security/advisories/new>.

Apache-2.0.
