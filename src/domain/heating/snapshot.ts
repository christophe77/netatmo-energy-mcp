import type { HomeStatusBody, RawModuleStatus, RawRoomStatus } from '../../netatmo/schemas.js';

/**
 * Normalised, timestamped view of `homestatus` (ADR-0011).
 * Used by the status tools today. A future opt-in collector would persist exactly this type.
 * `null` always means "not reported by Netatmo" — never a default or an estimate.
 */
export interface HomeSnapshot {
  homeId: string;
  /** Epoch ms: Netatmo server time when available, otherwise local time of retrieval. */
  observedAt: number;
  rooms: RoomSnapshot[];
  modules: ModuleSnapshot[];
  /** Per-device errors reported inside a successful response (e.g. code 6 = unreachable). */
  deviceErrors: { id: string | null; code: number }[];
}

export interface RoomSnapshot {
  roomId: string;
  temperatureC: number | null;
  setpointC: number | null;
  /** manual | max | off | schedule | away | hg (frost guard) */
  setpointMode: string | null;
  /** Epoch s. */
  setpointStartTime: number | null;
  /** Epoch s. */
  setpointEndTime: number | null;
  /** % of heat requested by the room's valves. Demand, not boiler power. */
  heatingDemandPercent: number | null;
  openWindow: boolean | null;
  anticipating: boolean | null;
  reachable: boolean | null;
}

export interface ModuleSnapshot {
  moduleId: string;
  type: string | null;
  reachable: boolean | null;
  /** Thermostat only: whether the boiler is currently requested to heat. */
  boilerOn: boolean | null;
  batteryState: string | null;
  batteryLevelMv: number | null;
  /** RF: 90 = low … 60 = full (lower is better). */
  rfStrength: number | null;
  /** Wi-Fi: 86 = poor … 56 = good (lower is better). */
  wifiStrength: number | null;
  firmwareRevision: string | null;
  /** OpenTherm gateway only. */
  boilerError: unknown;
}

export function toHomeSnapshot(
  body: HomeStatusBody,
  timeServer: number | undefined,
  now: number,
): HomeSnapshot {
  return {
    homeId: body.home.id,
    observedAt: timeServer === undefined ? now : timeServer * 1000,
    rooms: (body.home.rooms ?? []).map(toRoom),
    modules: (body.home.modules ?? []).map(toModule),
    deviceErrors: (body.errors ?? []).map((e) => ({ id: e.id ?? null, code: e.code })),
  };
}

function toRoom(r: RawRoomStatus): RoomSnapshot {
  return {
    roomId: r.id,
    temperatureC: r.therm_measured_temperature ?? null,
    setpointC: r.therm_setpoint_temperature ?? null,
    setpointMode: r.therm_setpoint_mode ?? null,
    setpointStartTime: r.therm_setpoint_start_time ?? null,
    setpointEndTime: r.therm_setpoint_end_time ?? null,
    heatingDemandPercent: r.heating_power_request ?? null,
    openWindow: r.open_window ?? r.open_windows ?? null,
    anticipating: r.anticipating ?? null,
    reachable: r.reachable ?? null,
  };
}

function toModule(m: RawModuleStatus): ModuleSnapshot {
  return {
    moduleId: m.id,
    type: m.type ?? null,
    reachable: m.reachable ?? null,
    boilerOn: m.boiler_status ?? null,
    batteryState: m.battery_state ?? null,
    batteryLevelMv: m.battery_level ?? null,
    rfStrength: m.rf_strength ?? m.rf_strenght ?? null,
    wifiStrength: m.wifi_strength ?? m.wifi_strenght ?? null,
    firmwareRevision: m.firmware_revision == null ? null : String(m.firmware_revision),
    boilerError: m.boiler_error ?? null,
  };
}
