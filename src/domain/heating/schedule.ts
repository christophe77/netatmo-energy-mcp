/**
 * Weekly heating schedules: readable views, patching and validation (ADR-0012).
 *
 * Netatmo timetables are lists of { zone_id, m_offset } where m_offset is minutes since
 * Monday 00:00; the zone applies until the next entry (wrapping over the week). Zones define a
 * setpoint per room. Schedules are always edited by patching an existing schedule so that
 * Netatmo's zone IDs/types are preserved and every heated room stays present.
 */
import { InvalidArgumentError, NotFoundError, UnsupportedCapabilityError } from '../../errors.js';
import {
  findRoom,
  foldName,
  type Home,
  type Schedule,
  type ScheduleZone,
} from '../homes/topology.js';

export const DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;
export type Day = (typeof DAYS)[number];
export const WEEK_MINUTES = 7 * 1440;

export interface TemperatureLimits {
  minTemp: number;
  maxTemp: number;
}

export function offsetToDayTime(mOffset: number): { day: Day; time: string } {
  const m = ((mOffset % WEEK_MINUTES) + WEEK_MINUTES) % WEEK_MINUTES;
  const day = DAYS[Math.floor(m / 1440)] ?? 'monday';
  const minutes = m % 1440;
  const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return { day, time };
}

export function dayTimeToOffset(day: string, time: string): number {
  const d = DAYS.indexOf(day.toLowerCase() as Day);
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  if (d < 0) throw new InvalidArgumentError(`Unknown day "${day}". Use monday … sunday.`);
  if (!match) throw new InvalidArgumentError(`Invalid time "${time}". Use HH:MM (24 h).`);
  return d * 1440 + Number(match[1]) * 60 + Number(match[2]);
}

export function heatingSchedules(home: Home): Schedule[] {
  return home.schedules.filter((s) => s.type === null || s.type === 'therm');
}

/** Find a heating schedule by ID or name; defaults to the active one. */
export function findSchedule(
  home: Home,
  ref?: { schedule_id?: string | undefined; schedule_name?: string | undefined },
): Schedule {
  const schedules = heatingSchedules(home);
  if (ref?.schedule_id) {
    const s = schedules.find((x) => x.id === ref.schedule_id);
    if (!s) throw new NotFoundError(`No heating schedule with ID ${ref.schedule_id}.`);
    return s;
  }
  if (ref?.schedule_name) {
    const wanted = foldName(ref.schedule_name);
    const matches = schedules.filter((x) => foldName(x.name ?? '') === wanted);
    const [match, ...rest] = matches;
    if (!match) {
      throw new NotFoundError(
        `No heating schedule named "${ref.schedule_name}". Schedules: ${schedules.map((x) => x.name ?? x.id).join(', ')}.`,
      );
    }
    if (rest.length > 0) {
      throw new InvalidArgumentError(
        `Several schedules are named "${ref.schedule_name}"; use schedule_id.`,
      );
    }
    return match;
  }
  const active = schedules.find((x) => x.selected);
  if (!active) throw new NotFoundError('No active heating schedule found.');
  return active;
}

export function findZone(schedule: Schedule, ref: string): ScheduleZone {
  const asId = /^\d+$/.test(ref.trim()) ? Number(ref) : undefined;
  const zone =
    schedule.zones.find((z) => z.id === asId) ??
    schedule.zones.find((z) => foldName(z.name ?? '') === foldName(ref));
  if (!zone) {
    throw new NotFoundError(
      `No zone "${ref}" in schedule ${schedule.name ?? schedule.id}. Zones: ${schedule.zones
        .map((z) => `${z.name ?? '?'} (id ${z.id})`)
        .join(', ')}.`,
    );
  }
  return zone;
}

function checkTemp(value: number, what: string, limits: TemperatureLimits): void {
  if (!Number.isFinite(value) || value < limits.minTemp || value > limits.maxTemp) {
    throw new InvalidArgumentError(
      `${what} must be between ${limits.minTemp} and ${limits.maxTemp} °C (got ${value}).`,
      { hint: 'Limits are set by NETATMO_MCP_MIN_TEMP / NETATMO_MCP_MAX_TEMP.' },
    );
  }
}

export interface SchedulePatch {
  name?: string | undefined;
  away_temperature?: number | undefined;
  frost_guard_temperature?: number | undefined;
  zone_temperatures?: { zone: string; room: string; temperature: number }[] | undefined;
  timetable?: { day: string; time: string; zone: string }[] | undefined;
}

/** Return a new schedule with `patch` applied. Only values the patch sets are limit-checked. */
export function applySchedulePatch(
  base: Schedule,
  home: Home,
  patch: SchedulePatch,
  limits: TemperatureLimits,
): Schedule {
  const next: Schedule = {
    ...base,
    timetable: base.timetable.map((t) => ({ ...t })),
    zones: base.zones.map((z) => ({ ...z, rooms: z.rooms.map((r) => ({ ...r })) })),
  };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name === '' || name.length > 64) {
      throw new InvalidArgumentError('Schedule names must be 1–64 characters.');
    }
    next.name = name;
  }
  if (patch.away_temperature !== undefined) {
    checkTemp(patch.away_temperature, 'The away temperature', limits);
    next.awayTempC = patch.away_temperature;
  }
  if (patch.frost_guard_temperature !== undefined) {
    checkTemp(patch.frost_guard_temperature, 'The frost-guard temperature', limits);
    next.frostGuardTempC = patch.frost_guard_temperature;
  }
  for (const change of patch.zone_temperatures ?? []) {
    const zone = findZone(next, change.zone);
    const room = findRoom(
      home,
      /^\d+$/.test(change.room) ? { roomId: change.room } : { roomName: change.room },
    );
    checkTemp(
      change.temperature,
      `The temperature for ${room.name} in zone ${zone.name ?? zone.id}`,
      limits,
    );
    const entry = zone.rooms.find((r) => r.roomId === room.id);
    if (!entry) {
      throw new InvalidArgumentError(
        `Room ${room.name} is not part of zone ${zone.name ?? zone.id}; only rooms with heating devices can be scheduled.`,
      );
    }
    entry.setpointC = change.temperature;
  }
  if (patch.timetable !== undefined) {
    next.timetable = patch.timetable
      .map((e) => ({ zoneId: findZone(next, e.zone).id, mOffset: dayTimeToOffset(e.day, e.time) }))
      .sort((a, b) => a.mOffset - b.mOffset);
  }
  validateSchedule(next);
  return next;
}

/** Structural checks before sending a schedule to Netatmo. */
export function validateSchedule(s: Schedule): void {
  if (s.zones.length === 0) throw new InvalidArgumentError('A schedule needs at least one zone.');
  // The whole schedule is sent back to Netatmo: refuse rather than send incomplete data that
  // would wipe values (e.g. a zone whose room setpoints Netatmo reported in another format).
  const incomplete = (what: string) =>
    new UnsupportedCapabilityError(
      `This schedule cannot be edited safely through the API: ${what}. Nothing was changed.`,
      { hint: 'Edit this schedule in the Netatmo app.' },
    );
  if (s.awayTempC === null || s.frostGuardTempC === null) {
    throw incomplete('Netatmo did not report its away and frost-guard temperatures');
  }
  for (const z of s.zones) {
    if (z.rooms.length === 0 || z.rooms.some((r) => r.setpointC === null)) {
      throw incomplete(`zone "${z.name ?? z.id}" has no setpoint for some rooms`);
    }
  }
  const ids = new Set(s.zones.map((z) => z.id));
  const tt = s.timetable;
  if (tt.length === 0) throw new InvalidArgumentError('The timetable is empty.');
  if (tt[0]?.mOffset !== 0) {
    throw new InvalidArgumentError('The timetable must start on Monday at 00:00.');
  }
  for (let i = 0; i < tt.length; i++) {
    const e = tt[i];
    if (!e) continue;
    if (!ids.has(e.zoneId))
      throw new InvalidArgumentError(`The timetable refers to unknown zone ${e.zoneId}.`);
    if (e.mOffset < 0 || e.mOffset >= WEEK_MINUTES) {
      throw new InvalidArgumentError('Timetable entries must fall within the week.');
    }
    const prev = tt[i - 1];
    if (prev && prev.mOffset >= e.mOffset) {
      throw new InvalidArgumentError('Two timetable entries start at the same time.');
    }
  }
}

/** Request body for createnewhomeschedule / synchomeschedule (pyatmo format). */
export function toApiSchedule(s: Schedule): Record<string, unknown> {
  return {
    away_temp: s.awayTempC,
    hg_temp: s.frostGuardTempC,
    timetable: s.timetable.map((t) => ({ zone_id: t.zoneId, m_offset: t.mOffset })),
    zones: s.zones.map((z) => ({
      id: z.id,
      name: z.name,
      type: z.type,
      rooms: z.rooms.map((r) => ({ id: r.roomId, therm_setpoint_temperature: r.setpointC })),
    })),
  };
}

export interface ScheduleView {
  id: string;
  name: string | null;
  active: boolean;
  away_temperature_c: number | null;
  frost_guard_temperature_c: number | null;
  zones: {
    id: number;
    name: string | null;
    type: number | null;
    rooms: { room_id: string; room_name: string; temperature_c: number | null }[];
  }[];
  timetable: { day: Day; time: string; zone: string }[];
}

export function scheduleView(s: Schedule, home: Home): ScheduleView {
  const zoneName = (id: number) => s.zones.find((z) => z.id === id)?.name ?? `zone ${id}`;
  return {
    id: s.id,
    name: s.name,
    active: s.selected,
    away_temperature_c: s.awayTempC,
    frost_guard_temperature_c: s.frostGuardTempC,
    zones: s.zones.map((z) => ({
      id: z.id,
      name: z.name,
      type: z.type,
      rooms: z.rooms.map((r) => ({
        room_id: r.roomId,
        room_name: home.rooms.find((x) => x.id === r.roomId)?.name ?? r.roomId,
        temperature_c: r.setpointC,
      })),
    })),
    timetable: s.timetable.map((t) => ({
      ...offsetToDayTime(t.mOffset),
      zone: zoneName(t.zoneId),
    })),
  };
}

/** Human-readable list of differences, for confirmation previews. */
export function describeScheduleChanges(before: Schedule, after: Schedule, home: Home): string[] {
  const out: string[] = [];
  if (before.name !== after.name) out.push(`Name: "${before.name ?? ''}" → "${after.name ?? ''}"`);
  if (before.awayTempC !== after.awayTempC)
    out.push(`Away temperature: ${before.awayTempC ?? '?'} → ${after.awayTempC ?? '?'} °C`);
  if (before.frostGuardTempC !== after.frostGuardTempC) {
    out.push(
      `Frost-guard temperature: ${before.frostGuardTempC ?? '?'} → ${after.frostGuardTempC ?? '?'} °C`,
    );
  }
  for (const z of after.zones) {
    const old = before.zones.find((x) => x.id === z.id);
    for (const r of z.rooms) {
      const prev = old?.rooms.find((x) => x.roomId === r.roomId)?.setpointC ?? null;
      if (prev !== r.setpointC) {
        const room = home.rooms.find((x) => x.id === r.roomId)?.name ?? r.roomId;
        out.push(`Zone ${z.name ?? z.id}, ${room}: ${prev ?? '?'} → ${r.setpointC ?? '?'} °C`);
      }
    }
  }
  const fmt = (s: Schedule) =>
    s.timetable.map((t) => {
      const { day, time } = offsetToDayTime(t.mOffset);
      return `${day} ${time} ${s.zones.find((z) => z.id === t.zoneId)?.name ?? t.zoneId}`;
    });
  const a = fmt(before).join('|');
  const b = fmt(after).join('|');
  if (a !== b)
    out.push(
      `Timetable: ${before.timetable.length} → ${after.timetable.length} entries (new: ${fmt(after).join('; ')})`,
    );
  return out;
}
