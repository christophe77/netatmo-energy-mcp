# Configuration

`netatmo-energy-mcp` needs almost no configuration. After
`netatmo-energy-mcp login`, the defaults below apply.

## Commands

| Command                                                                        | Purpose                                                                       |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `netatmo-energy-mcp` / `serve`                                                 | Start the MCP server on stdio (what MCP clients run)                          |
| `login [--write] [--manual] [--no-browser] [--client-id <id>] [--timeout <s>]` | OAuth2 login; stores credentials. `--write` enables [write mode](#write-mode) |
| `logout`                                                                       | Delete stored tokens and app credentials                                      |
| `status`                                                                       | Show login state, token expiry, scope and write mode (no secrets)             |
| `doctor`                                                                       | Check Node.js, folder permissions, credentials, token refresh and API access  |
| `probe [--days n] [--out dir] [--raw] [--refresh-test] [--rotation-test]`      | Record sanitized API responses for compatibility reports                      |

`<command> --help` shows details.

## Environment variables

All variables are optional.

| Variable                         | Default                          | Description                                                                                                                              |
| -------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `NETATMO_CLIENT_ID`              | stored value                     | Netatmo app client ID. Takes precedence over the stored one.                                                                             |
| `NETATMO_CLIENT_SECRET`          | stored value                     | Netatmo app client secret. Takes precedence over the stored one.                                                                         |
| `NETATMO_REDIRECT_URI`           | `http://localhost:8977/callback` | Must match the redirect URI registered in your Netatmo app                                                                               |
| `NETATMO_MCP_CONFIG_DIR`         | per-OS folder, see below         | Configuration folder. Use a dedicated folder: an existing folder containing other files is never re-permissioned.                        |
| `NETATMO_MCP_LOG_LEVEL`          | `info`                           | `debug`, `info`, `warn`, `error` or `silent`. Logs go to stderr.                                                                         |
| `NETATMO_MCP_WRITE`              | follows the login                | `0` forces read-only mode even after `login --write`. See [write mode](#write-mode).                                                     |
| `NETATMO_MCP_CONFIRM`            | `auto`                           | `elicitation` refuses changes unless the MCP client can ask you to confirm (elicitation). `auto` also allows the preview-and-token flow. |
| `NETATMO_MCP_MIN_TEMP`           | `7`                              | Write mode: lowest temperature (°C) a change may set, 5–30.                                                                              |
| `NETATMO_MCP_MAX_TEMP`           | `28`                             | Write mode: highest temperature (°C) a change may set, 5–30. `30` also allows the "max" boost.                                           |
| `NETATMO_MCP_MAX_SETPOINT_HOURS` | `24`                             | Write mode: longest manual room setpoint, in hours (0.25–720).                                                                           |

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
| `changes.log`        | Write mode only: one JSON line per applied or failed heating change      |
| `probe/<timestamp>/` | Output of `probe`, if you ran it                                         |

## Built-in limits

These limits are fixed and documented in the ADRs.

| Limit                      | Value                                                                                 | Why                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Netatmo requests           | 40 per 10 s and 400 per hour, per process                                             | 80 % of Netatmo's per-user limits ([ADR-0007](adr/0007-bounded-history-retrieval.md)) |
| Requests per history query | 8                                                                                     | No single question can use the hourly quota                                           |
| History range              | 400 days (14 days for anomaly detection)                                              | Bounded cost and output                                                               |
| History output             | 48 buckets (aggregated) or 200 points (detailed) by default, at most 1000             | Keeps responses small for the assistant                                               |
| Cache                      | Topology 10 min, current status 30 s                                                  | Several tool calls in one conversation reuse data                                     |
| HTTP timeout               | 15 s per request; reads: 3 attempts for network/5xx/429 errors; writes: never retried | Reliability without hanging the assistant; a write is never sent twice blindly        |

## Write mode

Write mode lets the assistant change the heating. It is off by default
([ADR-0012](adr/0012-opt-in-write-mode.md)).

**Enable.** Run `netatmo-energy-mcp login --write` and approve the extra
`write_thermostat` scope on netatmo.com, then restart your MCP client.
`status` and `doctor` show whether write mode is active.

**Disable.** Either set `NETATMO_MCP_WRITE=0` in the MCP client
configuration (the token keeps its scope, the server ignores it), or run
`login` again without `--write` to get a read-only token.

**Confirmation.** Every change is planned first, then applied only after
the user agrees:

1. If the MCP client supports elicitation, the server asks the user
   directly with a summary of the change.
2. Otherwise the tool returns `status: "confirmation_required"`, the list
   of changes and a `confirmation_token`. The token is single-use, valid
   for 5 minutes and bound to the exact arguments. The assistant must show
   the preview, and call the tool again with the token only if the user
   agrees.

The confirmation is bound to the exact request: if the heating data
changed in between (for example a schedule edited in the Netatmo app),
it is rejected and nothing is sent.

**Limitation of step 2.** A token proves that the arguments did not
change, not that a human agreed: an assistant that ignores its
instructions could call twice on its own. To require a real confirmation
prompt, set `NETATMO_MCP_CONFIRM=elicitation`. Changes are then refused
with clients that cannot ask you directly.

**Limits.** Changes outside `NETATMO_MCP_MIN_TEMP`–`NETATMO_MCP_MAX_TEMP`
(7–28 °C by default) are refused. Manual room setpoints always have an
end time: 3 hours by default, at most `NETATMO_MCP_MAX_SETPOINT_HOURS`
(24 h by default). The "max" boost sets 30 °C, so it is only allowed when
`NETATMO_MCP_MAX_TEMP=30`. Away and frost-guard modes can last up to one
year.

**Writes are never retried.** If Netatmo does not answer, the result says
the change may or may not have been applied. Check with
`netatmo_get_home_status` or `netatmo_get_schedules` before trying again.

**Audit log.** `changes.log` in the configuration folder gets one JSON
line per change: time, action, the parameters sent and the outcome
(`applied`, `failed`, or `unknown` when Netatmo gave no clear answer). It is never sent anywhere. Delete it whenever you
like.

**Netatmo API constraints.**

- There is no API to delete a schedule. Schedules created with
  `netatmo_create_schedule` can only be deleted in the Netatmo app.
- `netatmo_rename_schedule` and the `schedule_id` option of
  `netatmo_set_home_mode` rely on undocumented Netatmo parameters. They
  are marked experimental and may stop working.
- Editing a schedule sends the whole schedule (all zones and the full
  timetable) back to Netatmo, built from freshly read data plus your
  changes. If Netatmo reports a schedule incompletely (a zone without
  room setpoints, no away or frost-guard temperature), editing it is
  refused instead of sending partial data.
- `setstate` (the generic multi-device endpoint) is not exposed.
