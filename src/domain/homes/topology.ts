import { InvalidArgumentError, NotFoundError } from '../../errors.js';
import type { HomesDataBody, RawHome } from '../../netatmo/schemas.js';
import { deviceTypeInfo, type DeviceCategory } from '../devices/catalog.js';

export interface Room {
  id: string;
  name: string;
  type: string | null;
  moduleIds: string[];
}

export interface Module {
  id: string;
  type: string;
  model: string;
  category: DeviceCategory;
  name: string | null;
  roomId: string | null;
  /** Gateway this module talks through (null for gateways). */
  bridgeId: string | null;
  bridgedIds: string[];
  /** Unix seconds. */
  setupDate: number | null;
}

export interface ScheduleZone {
  id: number;
  name: string | null;
  /** Netatmo zone type (0 comfort/day, 1 night, 5 eco, …; see docs/api-capabilities.md). */
  type: number | null;
  rooms: { roomId: string; setpointC: number | null }[];
}

export interface Schedule {
  id: string;
  name: string | null;
  /** `therm` for heating schedules; other types (cooling, event…) are not editable here. */
  type: string | null;
  selected: boolean;
  isDefault: boolean;
  awayTempC: number | null;
  frostGuardTempC: number | null;
  timetable: { zoneId: number; mOffset: number }[];
  zones: ScheduleZone[];
}

export interface Home {
  id: string;
  name: string;
  /** IANA time zone, e.g. "Europe/Paris". */
  timezone: string | null;
  thermMode: string | null;
  temperatureControlMode: string | null;
  defaultManualDurationMin: number | null;
  rooms: Room[];
  modules: Module[];
  schedules: Schedule[];
}

/**
 * Normalise `homesdata` into the topology used everywhere else.
 * Location data (coordinates, altitude) and the account `user` block are intentionally dropped.
 */
export function toHomes(body: HomesDataBody): Home[] {
  return (body.homes ?? []).map(toHome);
}

function toHome(h: RawHome): Home {
  const modules: Module[] = (h.modules ?? []).map((m) => {
    const info = deviceTypeInfo(m.type);
    return {
      id: m.id,
      type: m.type,
      model: info.model,
      category: info.category,
      name: m.name ?? null,
      roomId: m.room_id ?? null,
      bridgeId: m.bridge ?? null,
      bridgedIds: m.modules_bridged ?? m.module_bridged ?? [],
      setupDate: m.setup_date ?? null,
    };
  });
  return {
    id: h.id,
    name: h.name ?? h.id,
    timezone: h.timezone ?? null,
    thermMode: h.therm_mode ?? null,
    temperatureControlMode: h.temperature_control_mode ?? null,
    defaultManualDurationMin:
      h.therm_setpoint_default_duration ?? h.therm_set_point_default_duration ?? null,
    rooms: (h.rooms ?? []).map((r) => ({
      id: r.id,
      name: r.name ?? r.id,
      type: r.type ?? null,
      moduleIds: r.module_ids ?? modules.filter((m) => m.roomId === r.id).map((m) => m.id),
    })),
    modules,
    schedules: (h.schedules ?? []).map((s) => ({
      id: s.id,
      name: s.name ?? null,
      type: s.type ?? null,
      selected: s.selected ?? false,
      isDefault: s.default ?? false,
      awayTempC: s.away_temp ?? null,
      frostGuardTempC: s.hg_temp ?? null,
      timetable: (s.timetable ?? []).map((t) => ({ zoneId: t.zone_id, mOffset: t.m_offset })),
      zones: (s.zones ?? []).map((z) => ({
        id: z.id,
        name: z.name ?? null,
        type: z.type ?? null,
        rooms: (z.rooms ?? []).map((r) => ({
          roomId: r.id,
          setpointC: r.therm_setpoint_temperature ?? null,
        })),
      })),
    })),
  };
}

/** Pick a home by ID, or the only home when no ID is given. */
export function selectHome(homes: Home[], homeId?: string): Home {
  if (homeId) {
    const home = homes.find((h) => h.id === homeId);
    if (!home) throw new NotFoundError(`No home with ID ${homeId} in this Netatmo account.`);
    return home;
  }
  const [only, ...others] = homes;
  if (!only) throw new NotFoundError('This Netatmo account has no homes with Energy devices.');
  if (others.length > 0) {
    throw new InvalidArgumentError(
      `This account has ${homes.length} homes; specify home_id (${homes.map((h) => `${h.name}: ${h.id}`).join(', ')}).`,
    );
  }
  return only;
}

/** Fold case and accents so "Séjour" matches "sejour". */
export function foldName(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

/** Resolve a room by ID or (accent/case-insensitive) name. Ambiguity lists the candidates. */
export function findRoom(home: Home, ref: { roomId?: string; roomName?: string }): Room {
  if (ref.roomId) {
    const room = home.rooms.find((r) => r.id === ref.roomId);
    if (!room) throw new NotFoundError(`No room with ID ${ref.roomId} in home ${home.name}.`);
    return room;
  }
  if (ref.roomName) {
    const wanted = foldName(ref.roomName);
    const exact = home.rooms.filter((r) => foldName(r.name) === wanted);
    const matches =
      exact.length > 0 ? exact : home.rooms.filter((r) => foldName(r.name).includes(wanted));
    const [match, ...rest] = matches;
    if (match && rest.length === 0) return match;
    const names = home.rooms.map((r) => r.name).join(', ');
    if (!match) throw new NotFoundError(`No room named "${ref.roomName}". Rooms: ${names}.`);
    throw new InvalidArgumentError(
      `"${ref.roomName}" matches several rooms: ${matches.map((r) => r.name).join(', ')}.`,
    );
  }
  throw new InvalidArgumentError('Specify a room by room_id or room_name.');
}

export interface HeatingSetup {
  gateways: Module[];
  thermostats: Module[];
  valves: Module[];
  other: Module[];
  /**
   * Where boiler history (getmeasure) can be read from: the thermostat module and the
   * gateway it is bridged through. Undefined when the home has no thermostat.
   */
  boilerSource: { deviceId: string; moduleId: string; thermostatType: string } | undefined;
}

/** Identify the heating equipment of a home from its topology (no assumption about models). */
export function describeHeatingSetup(home: Home): HeatingSetup {
  const by = (c: DeviceCategory) => home.modules.filter((m) => m.category === c);
  const thermostats = by('thermostat');
  const gateways = by('gateway');
  const thermostat = thermostats[0];
  let boilerSource: HeatingSetup['boilerSource'];
  if (thermostat) {
    const deviceId =
      thermostat.bridgeId ??
      (deviceTypeInfo(thermostat.type).selfBridged ? thermostat.id : undefined);
    if (deviceId)
      boilerSource = { deviceId, moduleId: thermostat.id, thermostatType: thermostat.type };
  }
  return { gateways, thermostats, valves: by('valve'), other: by('other'), boilerSource };
}

/** "1 × Netatmo Thermostat Relay (NAPlug), 6 × Netatmo Smart Radiator Valve (NRV)". */
export function summarizeDevices(home: Home): string {
  const counts = new Map<string, { model: string; n: number }>();
  for (const m of home.modules) {
    const entry = counts.get(m.type) ?? { model: m.model, n: 0 };
    entry.n += 1;
    counts.set(m.type, entry);
  }
  return [...counts.entries()]
    .map(([type, { model, n }]) => `${n} × ${model} (${type})`)
    .join(', ');
}
