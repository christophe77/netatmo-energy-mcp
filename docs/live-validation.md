# Live API validation

Before the MCP tools and analytics are built (Phases 4 and 5), the
assumptions in [api-capabilities.md](api-capabilities.md) are checked
against a real installation. Sections 1 to 7 are **read-only**: the tool
only holds the `read_thermostat` scope and cannot change heating
settings. [Section 8](#8-write-mode) covers the opt-in write mode.

The package is not published to npm yet, so run it from a local build.

## 1. Build

Requires Node.js ≥ 22.19 and pnpm.

```bash
git clone https://github.com/christophe77/netatmo-energy-mcp.git
cd netatmo-energy-mcp
pnpm install
pnpm build
```

The commands below use `node dist/index.js`. They work the same in
PowerShell, cmd, macOS and Linux.

## 2. Create a Netatmo app and log in

Follow [authentication.md](authentication.md), section 1, to create the
app with redirect URI `http://localhost:8977/callback`. Then run:

```bash
node dist/index.js login
```

Record the outcome. It answers open question 2: does Netatmo accept a
loopback redirect?

- **Browser redirect worked:** loopback redirect confirmed.
- **Netatmo rejected the redirect URI** (error page on netatmo.com): try
  `node dist/index.js login --manual`, and note the exact error text.

Optional PKCE check (question 1): run `login --experimental-pkce` once.
If login still succeeds, Netatmo at least tolerates the PKCE
parameters. This does not show whether it enforces them.

## 3. Doctor

```bash
node dist/index.js doctor
```

Expect every line to show `[ok]`. On Windows, the config folder line lists who has
access: your account and SYSTEM (and Administrators, if the folder was
created from an elevated terminal).

## 4. Probe

```bash
node dist/index.js probe --days 3
```

This takes about a minute. It makes about 15 read-only requests,
deliberately throttled to 4 per 10 s. It writes two files to
`<config folder>/probe/<timestamp>/`, which is outside the repository:

| File                 | Content                                                                                    | Share?                                     |
| -------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `report.md`          | Device types, field names, response shapes, boiler unit checks, rate-limit headers, errors | Yes, after a quick read                    |
| `responses.json`     | API responses with IDs replaced, generic names, no location or account data                | Review first; used to create test fixtures |
| `responses.raw.json` | Only with `--raw`: **unsanitized** responses                                               | **Never share or commit**                  |

## 5. Token rotation (optional, recommended)

```bash
node dist/index.js probe --days 1 --rotation-test
```

This refreshes the token once, then tries the _previous_ refresh token
again. It answers question 4 (is there a grace period?). The newest valid
tokens are always saved. If anything goes wrong, `login` again.

Make sure no other `netatmo-energy-mcp` process is running at the
time. None will be until the MCP server exists.

## 6. What the report answers

| Question ([api-capabilities §10](api-capabilities.md#10-questions-to-verify-against-the-live-api)) | Where in `report.md`                                                                       |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1. PKCE                                                                                            | Login outcome (step 2)                                                                     |
| 2. Loopback redirect                                                                               | Login outcome (step 2)                                                                     |
| 3. Token response keys and lifetime                                                                | _Tokens_ (with `--refresh-test` or `--rotation-test`)                                      |
| 4. Rotation grace period                                                                           | _Tokens_: "Rotation test" line                                                             |
| 5. `getroommeasure` body shape                                                                     | _Room history_: "segments", "timestamp map" or "OTHER shape"                               |
| 6. `scale=max`                                                                                     | Not tested (not in the documented enum)                                                    |
| 7. UTC epoch timestamps                                                                            | _Room history_ / _Boiler activity_: "first buckets local time" should match the wall clock |
| 8. Retention                                                                                       | Not tested yet (needs a long-range request; planned for Phase 4)                           |
| 9. Field spellings                                                                                 | _Current status_: "Spelling variants"                                                      |
| 10. Room ID type                                                                                   | _Topology_: "Room ID JSON type(s)"                                                         |
| 11. Rate-limit headers                                                                             | _Requests and rate limiting_                                                               |
| 12. Boiler history on OTM                                                                          | _Home_: thermostat type, then _Boiler activity_                                            |
| 13. Single-user app burst limit                                                                    | Any 429 status under _Requests_                                                            |

Boiler semantics ([api-capabilities §6](api-capabilities.md#boiler-activity-units-derived-values-limitations)):

- "on+off per bucket": observed ≈ **600** on a NATherm1 (seconds per 600 s
  sample). The documentation says minutes per hour, which would give 60.
- "Daily on+off sums": observed ≈ **86 400** (seconds per day). The
  documentation says minutes, which would give 1440.
- "Cross-check": heat demand derived from hourly data should roughly match
  the daily sums (about 5 % apart on the first live test).
- "first buckets local time" for `1day`: shows whether days start at
  local midnight or UTC midnight.

## 7. After validation

The maintainer updates `api-capabilities.md`, replacing UNCERTAIN labels
with dated observations. Sanitized fixtures are derived from
`responses.json` after review. Real IDs, names, addresses, coordinates
and tokens are never committed.

## 8. Write mode

These steps check the write endpoints on a real installation. They
**change the heating**, briefly and reversibly. Do them when a short
change is harmless, preferably in a room nobody is using.

1. Log in with write access, then confirm write mode is active:

   ```bash
   node dist/index.js login --write
   node dist/index.js status
   ```

2. Connect an MCP client (or the MCP Inspector) to `node dist/index.js`
   and run, confirming each change when asked:

   | Step | Ask the assistant                                                    | Check in the Netatmo app                                 |
   | ---- | -------------------------------------------------------------------- | -------------------------------------------------------- |
   | a    | "Set <room> to 18 °C for 10 minutes."                                | Manual setpoint with an end time; back to schedule after |
   | b    | "Put <room> back on its schedule."                                   | Room follows the schedule again                          |
   | c    | "Switch the home to frost guard until <in 15 minutes>."              | Frost-guard mode, then schedule mode after the end time  |
   | d    | "Switch the home back to schedule mode."                             | Schedule mode                                            |
   | e    | "Create a schedule called MCP test, copied from the active one."     | New schedule listed, **not** active                      |
   | f    | "In MCP test, set <room> to 17 °C in the Night zone."                | Only that value changed; timetable identical             |
   | g    | "Rename MCP test to MCP test 2." (experimental)                      | Name changed, or a clear error                           |
   | h    | Delete "MCP test 2" **in the Netatmo app** (no API exists for this). | Schedule gone                                            |

   Optional, experimental: with two schedules, "Switch to schedule mode
   using <other schedule>" from away mode tests `setthermmode` with
   `schedule_id`. Switch back afterwards.

3. Check `changes.log` in the configuration folder: one line per change,
   with `"outcome":"applied"`.

4. Report results in an issue, without IDs, names or the log contents.
   Most useful: whether `synchomeschedule` kept the schedule exactly as
   expected (step f), and the outcome of the experimental steps.

To return to read-only mode, run `node dist/index.js login` without
`--write`, or set `NETATMO_MCP_WRITE=0`.
