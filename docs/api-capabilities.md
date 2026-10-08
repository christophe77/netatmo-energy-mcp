# Netatmo Energy API — Capability Matrix

Status: research snapshot, 2026-10-08. Not yet validated against a live account (see [live-validation.md](live-validation.md)).

This document records what the Netatmo Connect API offers for Energy
devices (thermostats, smart radiator valves, relays) and what
`netatmo-energy-mcp` can therefore expose. Every fact carries a
confidence label:

| Label | Meaning |
|---|---|
| **VERIFIED** | Stated in Netatmo's official documentation (OpenAPI spec "Netatmo - Energy" v1.1.2 or the prose pages on dev.netatmo.com). |
| **CORROBORATED** | Not (or differently) documented, but relied on by maintained client libraries (pyatmo / Home Assistant, lnetatmo, Riges/Netatmo). |
| **UNCERTAIN** | Conflicting or missing evidence. Must be confirmed against the live API before we depend on it. |
| **UNSUPPORTED** | No documented way to obtain this data. We will not fabricate it. |

The official docs site (dev.netatmo.com) is a JavaScript app. Its content
was obtained from the same backend calls the site makes
(`/api/getdocumentationjson`, `/api/getwysiwyglayoutjson`). Netatmo's
documentation is not redistributed in this repository.

---

## 1. Base URL, auth and transport

| Item | Value | Status |
|---|---|---|
| API base URL | `https://api.netatmo.com/api` | VERIFIED |
| Auth header | `Authorization: Bearer <access_token>` | VERIFIED |
| Read endpoint method | Spec declares `GET`; pyatmo uses `POST` with form body | VERIFIED (GET) / CORROBORATED (POST) |
| Array parameters | Comma-separated (`type=temperature,sp_temperature`) | CORROBORATED |
| Response envelope | `{ "body": ..., "status": "ok", "time_exec": n, "time_server": n }` | VERIFIED |
| Error envelope | `{ "error": { "code": n, "message": "..." } }` | VERIFIED |

We will use `GET` (documented) for all read endpoints.

## 2. OAuth2

| Item | Value | Status |
|---|---|---|
| Authorize URL | `https://api.netatmo.com/oauth2/authorize` | VERIFIED |
| Token URL | `https://api.netatmo.com/oauth2/token` (form-encoded POST) | VERIFIED |
| Grant types | `authorization_code`, `refresh_token` | VERIFIED |
| Password grant | Not documented; removed in 2022–2023 per community reports | VERIFIED absent / CORROBORATED removed |
| `client_secret` | Required for code exchange **and** refresh → confidential client | VERIFIED |
| `state` | Supported, recommended for CSRF protection | VERIFIED |
| PKCE (`code_challenge`) | Not mentioned anywhere in docs, spec, portal JS or libraries | UNCERTAIN (assume unsupported) |
| `redirect_uri` | Must exactly match the one registered in the app (if any). Portal only validates that it contains `://` | VERIFIED |
| Loopback `http://localhost:<port>/...` accepted | Community examples use it; not documented | UNCERTAIN |
| Access token lifetime | `expires_in: 10800` (3 h) in doc example | VERIFIED (example) |
| Legacy `expire_in` key | Also present in responses, read by lnetatmo | CORROBORATED |
| Refresh token rotation | New refresh token on every refresh; **previous tokens are invalidated immediately** | VERIFIED |
| Scope for Energy read | `read_thermostat` | VERIFIED |
| Scope for Energy write | `write_thermostat` (never requested in v0.1) | VERIFIED |
| Scope for BTicino Smarther (BNS) | `read_smarther` | VERIFIED (scope table); need for BNS homes UNCERTAIN |
| Default scope if none requested | `read_station` (Weather) | VERIFIED |

**Consequence for design:** refresh-token rotation with immediate
invalidation means two processes refreshing at the same time will lock
one of them out. See [ADR-0005](adr/0005-token-storage-and-refresh.md).

## 3. Endpoints

### Read endpoints (used)

| Endpoint | Parameters | Purpose | Status |
|---|---|---|---|
| `GET /homesdata` | `home_id`?, `gateway_types`? (`NAPlug`,`OTH`,`BNS`) | Topology: homes, rooms, modules, schedules | VERIFIED |
| `GET /homestatus` | `home_id`*, `device_types`? | Current state of rooms and modules | VERIFIED |
| `GET /getroommeasure` | `home_id`*, `room_id`*, `scale`*, `type`*, `date_begin`, `date_end`, `limit`, `optimize`, `real_time` | Room temperature / setpoint history | VERIFIED |
| `GET /getmeasure` | `device_id`* (gateway MAC), `module_id`* (thermostat MAC), `scale`*, `type`*, `date_begin`, `date_end`, `limit`, `optimize`, `real_time` | Boiler activity history | VERIFIED |

### Write endpoints (documented, **never called** by this project)

`POST /setroomthermpoint`, `POST /setthermmode`, `POST /createnewhomeschedule`,
`POST /synchomeschedule`, `POST /switchhomeschedule` — all require
`write_thermostat`, which v0.1 never requests. VERIFIED.

### Legacy endpoints (not used)

| Endpoint | Note | Status |
|---|---|---|
| `getthermostatsdata` | Old Thermostat API; absent from every current OpenAPI file | VERIFIED absent; live behaviour UNCERTAIN |
| `gethomedata` | Old Security endpoint, superseded by `homesdata` | Not used |

## 4. Topology (`homesdata`)

| Field | Notes | Status |
|---|---|---|
| `homes[].id`, `name`, `timezone`, `country`, `altitude`, `coordinates` | `coordinates` and `altitude` are location data → **not exposed** by default | VERIFIED |
| `homes[].therm_mode` | `schedule` / `away` / `hg` (frost guard) | VERIFIED |
| `homes[].temperature_control_mode` | `heating` / `cooling` | VERIFIED |
| `homes[].therm_setpoint_default_duration` | Spec spells it `therm_set_point_default_duration` | CORROBORATED (glossary + pyatmo spelling) |
| `rooms[].id`, `name`, `type`, `module_ids[]` | `id` documented as string in glossary, int64 in spec → treat as string | VERIFIED / UNCERTAIN type |
| `modules[].id` (MAC), `type`, `name`, `setup_date`, `room_id`, `bridge`, `modules_bridged[]` | Spec misspells `modules_bridged` | VERIFIED / CORROBORATED |
| `schedules[]` (`timetable`, `zones`, `away_temp`, `hg_temp`, `selected`) | Weekly schedules; `m_offset` = minutes since Monday 00:00 | VERIFIED |
| `body.user` (email, locale…) | **PII — never exposed or logged** | VERIFIED |

## 5. Current status (`homestatus`)

### Rooms

| Field | Meaning | Status |
|---|---|---|
| `therm_measured_temperature` | Measured room temperature (°C) | VERIFIED |
| `therm_setpoint_temperature` | Target temperature (°C) | VERIFIED |
| `therm_setpoint_mode` | `manual`, `max`, `off`, `schedule`, `away`, `hg` | VERIFIED |
| `therm_setpoint_start_time`, `therm_setpoint_end_time` | Unix seconds | VERIFIED |
| `heating_power_request` | % heat requested by the room (valve demand). **Not boiler power.** | VERIFIED |
| `anticipating` | Anticipation in progress | VERIFIED |
| `reachable` | False if no module in the room is reachable | VERIFIED |
| `open_window` / `open_windows` | Spec says `open_windows`, pyatmo reads `open_window` → accept both | UNCERTAIN |

### Modules

| Type | Fields | Status |
|---|---|---|
| `NAPlug` (relay) | `firmware_revision`, `wifi_strength` | VERIFIED (spec misspells `wifi_strenght`) |
| `OTH` (OpenTherm gateway) | `firmware_revision`, `wifi_strength`, `boiler_control`, `dhw_control`, `boiler_error` | VERIFIED |
| `NATherm1` / `OTM` (thermostat) | `reachable`, `firmware_revision`, `rf_strength`, `boiler_status` (bool), `boiler_valve_comfort_boost`, `anticipating`, `battery_state`, `bridge` | VERIFIED |
| `NRV` (valve) | `reachable`, `firmware_revision`, `rf_strength`, `battery_state`, `bridge` | VERIFIED |
| `battery_level` (mV) | Not in spec; read by pyatmo | CORROBORATED |
| `body.errors[]` | `{ id, code }`, e.g. code 6 = unreachable | VERIFIED |

Signal scales: RF 90 = low … 60 = full; Wi-Fi 86 = poor … 56 = good
(lower is better). VERIFIED.

## 6. Historical measurements

### `getroommeasure` types (per room)

| `type` | Meaning | Scales | Status |
|---|---|---|---|
| `temperature` | Measured temperature | all | VERIFIED |
| `sp_temperature` | Setpoint temperature | all | VERIFIED |
| `min_temp`, `max_temp` | Min / max over the step | all | VERIFIED |
| `date_min_temp`, `date_max_temp` | Timestamp of min / max | `1day`, `1week`, `1month` only | VERIFIED |

### `getmeasure` types (boiler, thermostat module)

| `type` | Meaning | Scales | Status |
|---|---|---|---|
| `boileron` / `boileroff` | **Average minutes per hour** the boiler is on / off | `30min`, `1hour`, `3hours` | VERIFIED |
| `sum_boiler_on` / `sum_boiler_off` | **Sum of minutes** on / off over the step | `1day`, `1week`, `1month` | VERIFIED |

`boiler on` means the thermostat's relay / OpenTherm demand was active.
It is **not** gas consumption and **not** burner modulation.

#### Boiler activity: units, derived values, limitations

Documented units (VERIFIED wording, not yet checked against live data):

| Measure | Documented unit | Derived "active minutes in bucket" |
|---|---|---|
| `boileron` at step *s* (30 min, 1 h or 3 h) | average minutes active **per hour** | `boileron × s / 60 min` |
| `sum_boiler_on` at 1 day, 1 week or 1 month | minutes active in the bucket | used as is |

Live checks to run before any analytics depend on these
([live-validation.md](live-validation.md)):

1. For `1hour` buckets, `boileron + boileroff` should be about 60. If
   it is, the per-hour unit is confirmed.
2. Over the same days, Σ(`boileron` at `1hour`) should be about
   Σ(`sum_boiler_on` at `1day`). If it is, the derivation formula is
   confirmed.
3. At `30min`, check whether the value is still per hour or per
   30-minute bucket.
4. Whether day buckets follow local or UTC midnight.

Limitations that every tool output carries in its `caveats` field:

- These values show when the thermostat **requested heat**: relay
  closed, or OpenTherm demand active. They are not burner runtime at a
  known power. They are not gas or energy use.
- They are **aggregates**. A value of 20 minutes in an hour could be one
  20-minute run or ten 2-minute runs. **The number of boiler cycles
  cannot be derived** from these measures. `homestatus.boiler_status`
  is a point-in-time value only.
- With OpenTherm (OTH/OTM), the boiler modulates, so "on" minutes and
  heat delivered are related only loosely.

### Scales and limits

| Item | Value | Status |
|---|---|---|
| `scale` enum | `30min`, `1hour`, `3hours`, `1day`, `1week`, `1month` | VERIFIED |
| `scale=max` (raw) | In Weather API; **not** in Energy enum | UNCERTAIN |
| Max points per request | `limit` default and max = **1024** | VERIFIED |
| `date_begin` / `date_end` | Unix seconds ("Local Unix Time" in spec; expected UTC epoch) | VERIFIED / UNCERTAIN semantics |
| `real_time=false` (default) | Timestamps shifted by `scale/2` (bucket centre) | VERIFIED |
| `optimize=true` (default) | `body: [{ beg_time, step_time, value: [[v1, v2…]…] }]`, new segment after each gap | CORROBORATED (spec schema for `getroommeasure` disagrees) |
| `optimize=false` | `body: { "<ts>": [v1, v2…] }` | CORROBORATED |
| Retention | Undocumented ("oldest data available") | UNCERTAIN |

Points per request at max `limit` = 1024:

| Scale | Coverage per request |
|---|---|
| `30min` | ≈ 21.3 days |
| `1hour` | ≈ 42.7 days |
| `3hours` | ≈ 128 days |
| `1day` | ≈ 2.8 years |

### Not available as history

| Data | Status |
|---|---|
| `heating_power_request` history (valve demand over time) | **UNSUPPORTED** — only current value via `homestatus` |
| Valve opening position | **UNSUPPORTED** |
| Gas / energy consumption for boilers | **UNSUPPORTED** |
| Burner modulation level (OpenTherm) | **UNSUPPORTED** |
| Outdoor temperature | **UNSUPPORTED** in Energy API (Weather API / Open-Meteo in v0.3) |
| Window-open events history | **UNSUPPORTED** |
| Setpoint change log / who changed it | **UNSUPPORTED** (only `sp_temperature` series) |

## 7. Rate limits

| Limit | Value | Status |
|---|---|---|
| Per user | 50 requests / 10 s, 500 requests / hour | VERIFIED |
| Per app, burst | `2 × users` requests / 10 s, capped at 200 | VERIFIED (wording ambiguous) |
| Per app, hourly | < 500 users: 2,000 / hour (higher tiers above) | VERIFIED |
| `Retry-After` | "may be included" on 429 | VERIFIED |

Each user of this project registers their **own** Netatmo app
([ADR-0004](adr/0004-bring-your-own-netatmo-app.md)), so the app has a
single user. Read literally, the per-app burst limit would then be
2 requests / 10 s. Whether that applies in practice is **UNCERTAIN**. The
client therefore uses a conservative local limiter, honours
`Retry-After`, and caps the number of requests one tool call may make.

## 8. Error codes

| HTTP | Code | Meaning | Client behaviour |
|---|---|---|---|
| 400 | 10, 21, 25 | Missing / invalid argument / invalid date | `InvalidRequestError`, no retry |
| 401/403 | 2, 3 | Invalid / expired access token | Refresh once, then retry once |
| 403 | 13 | Operation forbidden (scope) | `PermissionError`, suggest re-login |
| 403 | 30, `invalid_grant` | Invalid refresh token | `AuthRequiredError` → `login` |
| 403 / 429 | 26 | Usage limit reached (app or user) | `RateLimitError`, backoff |
| 429 | 28, 29 | Rate limit / temporarily restricted | `RateLimitError`, honour `Retry-After` |
| 429 | 11 | Concurrency (pyatmo, not in official table) | Retry with backoff |
| 404 | 9 | Device not found | `NotFoundError` |
| 406 | 5 | Application deactivated | `AuthRequiredError` with explanation |
| 5xx | — | Server error | Retry with exponential backoff (reads only) |

`homestatus` also returns per-device errors inside a 200 response
(`body.errors[]`, e.g. 6 = device unreachable). These are surfaced as
warnings, not failures.

## 9. Device types

| Type | Product | v0.1 support |
|---|---|---|
| `NAPlug` | Thermostat relay (gateway) | Expected |
| `NATherm1` | Smart Thermostat (on/off relay) | Expected; maintainer will test |
| `NRV` | Smart Radiator Valve | Expected; maintainer will test |
| `OTH` | OpenTherm gateway | Expected, untested |
| `OTM` | OpenTherm Modulating Thermostat | Expected, untested |
| `BNS` | BTicino Smarther with Netatmo | Listed, untested (may need `read_smarther`) |
| `NAC`, `NLC`, `BNTH`, other Legrand/BTicino | Not Energy thermostat devices | Out of scope |

"Expected" means the documented data model covers it. Real test status
lives in the README's *Supported Devices* table and is only upgraded
after a real installation has been checked.

## 10. Questions to verify against the live API

1. Whether PKCE parameters are accepted, ignored or rejected.
2. Whether a loopback redirect (`http://localhost:<port>/callback`) works when registered.
3. Exact token response keys (`expires_in` vs `expire_in`, `scope`) and real lifetime.
4. Whether there is any grace period after refresh-token rotation.
5. The real `getroommeasure` body shape (library shape vs spec shape).
6. Whether `scale=max` is accepted on Energy endpoints.
7. That `date_begin`/`date_end` are UTC epoch seconds.
8. How far back history is retained per scale.
9. Live spelling of `open_window(s)`, `rf_strength`, `wifi_strength`, `therm_setpoint_default_duration`.
10. Whether room IDs arrive as JSON strings or numbers.
11. Which HTTP status / code pairs indicate rate limiting, and whether `Retry-After` is sent.
12. Whether `getmeasure` boiler history works for `OTM` the same way as `NATherm1`.
13. The effective per-app burst limit for a single-user app.

The maintainer's installation (NATherm1-class thermostat + 6 NRV +
gas boiler) can answer 1–11. Results go into this file with a dated note.
