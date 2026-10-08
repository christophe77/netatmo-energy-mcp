# Configuration

`netatmo-energy-mcp` needs almost no configuration. After
`netatmo-energy-mcp login`, the defaults below apply.

## Commands

| Command                                                                   | Purpose                                                                      |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `netatmo-energy-mcp` / `serve`                                            | Start the MCP server on stdio (what MCP clients run)                         |
| `login [--manual] [--no-browser] [--client-id <id>] [--timeout <s>]`      | OAuth2 login; stores credentials                                             |
| `logout`                                                                  | Delete stored tokens and app credentials                                     |
| `status`                                                                  | Show login state, token expiry and scope (no secrets)                        |
| `doctor`                                                                  | Check Node.js, folder permissions, credentials, token refresh and API access |
| `probe [--days n] [--out dir] [--raw] [--refresh-test] [--rotation-test]` | Record sanitized API responses for compatibility reports                     |

`<command> --help` shows details.

## Environment variables

All variables are optional.

| Variable                 | Default                          | Description                                                                                                       |
| ------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `NETATMO_CLIENT_ID`      | stored value                     | Netatmo app client ID. Takes precedence over the stored one.                                                      |
| `NETATMO_CLIENT_SECRET`  | stored value                     | Netatmo app client secret. Takes precedence over the stored one.                                                  |
| `NETATMO_REDIRECT_URI`   | `http://localhost:8977/callback` | Must match the redirect URI registered in your Netatmo app                                                        |
| `NETATMO_MCP_CONFIG_DIR` | per-OS folder, see below         | Configuration folder. Use a dedicated folder: an existing folder containing other files is never re-permissioned. |
| `NETATMO_MCP_LOG_LEVEL`  | `info`                           | `debug`, `info`, `warn`, `error` or `silent`. Logs go to stderr.                                                  |

If `NETATMO_CLIENT_ID` points to a different app than the one that issued
the stored tokens, you are asked to log in again.

## Configuration folder

| OS      | Folder                                                                         |
| ------- | ------------------------------------------------------------------------------ |
| Windows | `%APPDATA%\netatmo-energy-mcp`                                                 |
| macOS   | `~/Library/Application Support/netatmo-energy-mcp`                             |
| Linux   | `$XDG_CONFIG_HOME/netatmo-energy-mcp` (default `~/.config/netatmo-energy-mcp`) |

Contents:

| File                 | Content                                                                  |
| -------------------- | ------------------------------------------------------------------------ |
| `credentials.json`   | Client ID and secret, access and refresh tokens (owner-only permissions) |
| `credentials.lock`   | Short-lived lock used while refreshing tokens                            |
| `probe/<timestamp>/` | Output of `probe`, if you ran it                                         |

## Built-in limits

These limits are fixed and documented in the ADRs.

| Limit                      | Value                                                                     | Why                                                                                   |
| -------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Netatmo requests           | 40 per 10 s and 400 per hour, per process                                 | 80 % of Netatmo's per-user limits ([ADR-0007](adr/0007-bounded-history-retrieval.md)) |
| Requests per history query | 8                                                                         | No single question can use the hourly quota                                           |
| History range              | 400 days (14 days for anomaly detection)                                  | Bounded cost and output                                                               |
| History output             | 48 buckets (aggregated) or 200 points (detailed) by default, at most 1000 | Keeps responses small for the assistant                                               |
| Cache                      | Topology 10 min, current status 30 s                                      | Several tool calls in one conversation reuse data                                     |
| HTTP timeout               | 15 s per request, 3 attempts for network/5xx/429 errors                   | Reliability without hanging the assistant                                             |
