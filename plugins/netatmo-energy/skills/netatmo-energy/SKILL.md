---
name: netatmo-energy
description: Answer questions about a Netatmo Energy heating system (smart thermostat, radiator valves) with the netatmo-energy MCP tools, and change the heating safely when asked. Use when the user asks about room temperatures, setpoints, the boiler, heating schedules, batteries or signal of Netatmo devices, a cold or overheated room, a heating report or room comparison, or wants to change a setpoint, the home mode or a weekly schedule.
---

# Netatmo Energy

The `netatmo-energy` MCP server reads (and, in write mode, changes) a real
Netatmo heating system. This skill gives the order in which to call its tools
for common requests and the rules for reading and presenting the results.

## Ground rules

- **No energy figures.** Netatmo does not measure gas or electricity. Boiler
  "heat demand" time is when the thermostat asked for heat, not gas burned.
  `heating_demand_percent` is what a room requests, not boiler power. Never
  estimate consumption, cost or CO2 from them.
- **Gaps stay gaps.** Missing measurements are reported in `coverage` and
  `notes`. Say so; never interpolate.
- **Observations, not diagnoses.** Do not claim "the valve is broken".
  Describe what the data shows and give possible explanations as hypotheses.
- **Units and time.** Temperatures in °C, durations in minutes, times in the
  home's time zone. Show times as local clock times ("07:30"), not raw ISO
  strings.
- **Rooms by name.** Every room tool accepts `room_name` (case- and
  accent-insensitive). `home_id` can be omitted when the account has one home.
  Call `netatmo_list_homes` only when there may be several homes or a tool
  asks for one.

## Picking the cheapest call

| Question                              | Tool                                                       |
| ------------------------------------- | ---------------------------------------------------------- |
| "How warm is it at home?"             | `netatmo_get_home_status` (all rooms, alerts, boiler)      |
| One room right now                    | `netatmo_get_room_status`                                  |
| Is the boiler running / who asks heat | `netatmo_get_heating_status`                               |
| Batteries, signal, offline devices    | `netatmo_get_device_status`                                |
| Overview of a day or week             | `netatmo_get_heating_summary` (one call, all rooms)        |
| Ranking rooms                         | `netatmo_compare_rooms`                                    |
| Something odd happened                | `netatmo_detect_anomalies`                                 |
| Curve of one room                     | `netatmo_get_temperature_history` + `..._setpoint_history` |
| Weekly timetable, zones               | `netatmo_get_schedules`                                    |

History modes: use `summary` for statistics only, `aggregated` (default) for a
chart-sized series, and `detailed` only for a few hours around a specific
event. Prefer named periods (`today`, `yesterday`, `last_24h`, `last_7d`,
`last_30d`) over `from`/`to`. The analytics tools already compute statistics
and rankings: use them instead of pulling raw history for every room.

## Workflows

### "Room X is cold" / "Room X is too hot"

1. `netatmo_get_room_status` with `room_name`: measured temperature, setpoint,
   setpoint mode, heating demand, open window.
2. If the setpoint itself explains it (low setpoint, `away` or `frost_guard`
   mode, a schedule zone like Night or Eco), say so and stop. Use
   `netatmo_get_schedules` to name the zone and when it ends.
3. Otherwise `netatmo_get_setpoint_history` and
   `netatmo_get_temperature_history` for `last_24h` to see how long the gap
   has lasted.
4. `netatmo_detect_anomalies` for that room and `netatmo_get_device_status`
   (battery, signal, reachability of the room's valve or thermostat).
5. `netatmo_get_heating_status`: is the room requesting heat, is the boiler
   on?

Possible explanations to weigh (as hypotheses): open window detected, device
unreachable or low battery, setpoint reached elsewhere but not here (valve
position, radiator size), boiler not requested, anticipation still running.

### Daily or weekly report

1. `netatmo_get_heating_summary` for the period (`yesterday` or `last_7d`).
2. `netatmo_detect_anomalies` for the same period (at most 14 days).
3. Weekly or longer: `netatmo_get_boiler_history` with `scale: "1day"`,
   `mode: "aggregated"` for day-to-day heat-demand time.
4. `netatmo_get_home_status` for current alerts.

Present a table per room (min / mean / max, mean setpoint, time below and
above target), the total heat-demand time, then notable events. Without
outdoor temperatures, day-to-day differences may just be the weather: say so.

### Comparing rooms

`netatmo_compare_rooms` for the period (default `last_7d`). Show the per-room
metrics as a table, then the rankings it returns. Do not re-rank by hand.

### Optimisation ideas

Combine `netatmo_get_heating_summary`, `netatmo_compare_rooms` and
`netatmo_get_schedules`. Look for rooms that stay above their setpoint, high
setpoints for the room type or time of day, and heat demand while rooms are
likely empty. Express savings qualitatively only.

## Changing the heating (write mode)

Write tools exist only when the user ran `netatmo-energy-mcp login --write`.
If they are missing and the user asks for a change, say that the server is
read-only and point to `npx -y netatmo-energy-mcp login --write` (then restart
Claude Code), or to the Netatmo app.

Only change the heating when the user asked for that change. Then:

1. **Read first.** `netatmo_get_room_status` before a setpoint change;
   `netatmo_get_schedules` before switching, creating or editing a schedule.
   Use the IDs and zone names it returns.
2. **Pick the smallest change.** A temporary setpoint
   (`netatmo_set_room_setpoint`, mode `manual`, with `duration_minutes` or
   `until`) rather than a schedule edit for "warm the living room for the
   evening". `mode: "schedule"` returns a room to its timetable. To try a new
   timetable, prefer `netatmo_create_schedule` (a copy, not activated) over
   editing the active one.
3. **Call once without a token.** Either the client shows the user a
   confirmation dialog, or the tool returns `status: "confirmation_required"`,
   a list of changes and a `confirmation_token`.
4. **Show the preview** in plain words: room or schedule, from → to values,
   end time. Ask for a yes.
5. **Only after an explicit yes** in the user's own reply, call again with the
   same arguments plus `confirmation_token`. Never reuse a token, never pass
   one the user has not seen, never batch several changes under one approval.
   The token expires after 5 minutes and is rejected if the heating changed
   meanwhile: then read again and show a new preview.
6. **Confirm the result** with `netatmo_get_room_status` or
   `netatmo_get_schedules`.

Edits to a timetable replace it entirely: the first entry must be Monday
00:00, and every entry applies its zone until the next one. Start from the
timetable returned by `netatmo_get_schedules` and change only what was asked.
Schedules cannot be deleted through the API, only in the Netatmo app.

Changes outside the configured limits (default 7–28 °C, manual setpoints up to
24 h) are refused: report the limit instead of retrying with other values.

## Errors

Tools return `isError: true` with `error.code`, `message` and `hint`. Relay
the hint.

- `AUTH_REQUIRED`: run `npx -y netatmo-energy-mcp login`, then restart
  Claude Code.
- `RATE_LIMITED`: wait; do not loop on the call.
- `UNSUPPORTED_CAPABILITY`: the hardware lacks it (for example boiler
  history without a Netatmo thermostat). Say so and use another source.
- `NOT_FOUND`: list the rooms or schedules and ask which one was meant.
