# ADR-0012: Opt-in write mode

Status: Accepted (2026-10-08). Supersedes ADR-0002 for write operations.
ADR-0002 still applies by default: without write mode, the server is
read-only exactly as before.
Date: 2026-10-08

## Context

The maintainer wants assistants to do everything the Netatmo Energy API
technically allows. The API offers these write operations (scope
`write_thermostat`):

| Endpoint                       | Status                                | Effect                                                                                                                                                             |
| ------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `setroomthermpoint`            | Documented                            | Room setpoint: `manual` (temperature + end time), `max` (30 °C boost) or `home` (back to schedule)                                                                 |
| `setthermmode`                 | Documented                            | Home mode: `schedule`, `away`, `hg` (frost guard), with an optional end time for away/hg                                                                           |
| `switchhomeschedule`           | Documented                            | Activate another weekly schedule                                                                                                                                   |
| `createnewhomeschedule`        | Documented                            | Create a weekly schedule (all heated rooms required; zones 0, 1 and 4 mandatory)                                                                                   |
| `synchomeschedule`             | Documented                            | Replace the content of a weekly schedule                                                                                                                           |
| `setthermmode` + `schedule_id` | Undocumented (pyatmo)                 | Return to schedule mode with a specific schedule                                                                                                                   |
| `renamehomeschedule`           | Undocumented (other client libraries) | Rename a schedule                                                                                                                                                  |
| `setstate`                     | Undocumented for Energy               | Generic Legrand endpoint. For Energy rooms it only duplicates `setroomthermpoint`, apart from pilot-wire and cooling features these devices lack. **Not exposed.** |
| Delete a schedule              | **Does not exist**                    | Only possible in the Netatmo app                                                                                                                                   |

Writing to a physical heating system raises the stakes:

- An assistant can misunderstand a request.
- Text injected into its context (prompt injection) can try to trigger
  changes.
- MCP tool annotations are hints only, and clients are not required to
  enforce them.

## Decision (choices made by the maintainer)

1. **Opt-in at login.** `netatmo-energy-mcp login --write` requests
   `read_thermostat write_thermostat`. Write tools are registered only
   when the stored token's granted scope contains `write_thermostat`. A
   read-only login keeps a token that cannot write.
   `NETATMO_MCP_WRITE=0` forces read-only operation for a particular
   client even with a write-capable token.
2. **Every change is confirmed by the user.**
   - With clients that support elicitation, the server asks the user
     directly. It uses `inputRequired` on protocol 2026-07-28 and
     `elicitInput` on 2025-era sessions.
   - Otherwise there are two steps. The first call returns a preview and
     a single-use `confirmation_token`, bound to the exact parameters
     and expiring after 5 minutes. A second call with the token applies
     the change. The tool description instructs the assistant to obtain
     the user's explicit agreement first.
   - Every confirmation (token, or the 2026-07-28 `requestState`) is
     also bound to a digest of the exact request that will be sent. If
     the heating data changed between preview and confirmation, the
     confirmation is rejected and nothing is sent.
   - **Limitation.** The token flow cannot prove that a human agreed: the
     model itself can call twice. It protects against accidental and
     silently changed writes, not against a model that ignores its
     instructions. `NETATMO_MCP_CONFIRM=elicitation` refuses changes
     unless the client can ask the user itself. Names from Netatmo are
     stripped of control characters in previews.
3. **Limits** are configurable through environment variables:
   - Temperatures between **7 and 28 °C**
     (`NETATMO_MCP_MIN_TEMP` / `NETATMO_MCP_MAX_TEMP`), for setpoints
     and schedules.
   - Manual setpoints are always temporary: at most **24 h**
     (`NETATMO_MCP_MAX_SETPOINT_HOURS`), 3 h by default.
   - `max` mode (30 °C) is refused unless the maximum is raised to 30.
4. **Undocumented endpoints are included** (choice made by the
   maintainer), except `setstate`. They are marked **experimental** in
   tool descriptions until validated live.
5. **Schedules are edited by patching an existing schedule.** Creation
   clones a base schedule, the active one by default. Plans are built
   from fresh data (caches are bypassed), so an edit made in the Netatmo
   app is never reverted by a stale copy. Both then apply the requested changes and send a
   complete, validated schedule. Netatmo's zone ID and type conventions
   are thereby preserved, every heated room is always present, and the
   timetable must start at Monday 00:00. A schedule whose data from
   Netatmo is incomplete (a zone without room setpoints, missing away or
   frost-guard temperatures) is refused rather than sent back partially.
6. **Safety in the client.**
   - Write endpoints live in a separate allow-list. The client refuses
     them unless constructed with `allowWrites`.
   - Writes (POST) are **never retried** after network errors or 5xx
     responses, because the outcome is unknown. They are retried once
     only when the token was rejected before execution.
   - Caches are cleared after every write.
7. **Audit log.** Every attempted change is appended to
   `<config folder>/changes.log` (JSON Lines: time, action, parameters,
   outcome `applied`, `failed` or `unknown` when Netatmo gave no clear
   answer). It stays local.

## Consequences

- Read-only users are unaffected. The read-only tests now assert that,
  without write mode, no write tool is registered and the client cannot
  call write endpoints.
- `docs/api-capabilities.md` lists the write endpoints. Live validation
  of the write paths, especially the schedule JSON format and the
  experimental endpoints, is required before the release that ships
  them.
- Schedules created through the API can only be deleted in the Netatmo
  app. Tool descriptions say so.
