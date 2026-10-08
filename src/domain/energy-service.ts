/**
 * Application service: the single entry point used by MCP tools and resources.
 * Independent of MCP; returns the views defined in ./views.ts.
 */
import { InvalidArgumentError } from '../errors.js';
import type { NetatmoClient } from '../netatmo/client.js';
import { LARGE_SCALES, SCALE_SECONDS, type Scale } from '../netatmo/endpoints.js';
import type { MeasurePoint } from '../netatmo/measures.js';
import { systemClock, type Clock } from '../utils/clock.js';
import { addLocalDays, formatIso } from '../utils/dates.js';
import { boilerOnSeconds, BOILER_CAVEATS } from './heating/boiler.js';
import { toHomeSnapshot, type HomeSnapshot, type ModuleSnapshot } from './heating/snapshot.js';
import type { HistoryService } from './history/history-service.js';
import {
  alignBegin,
  chooseRoomScale,
  expectedPoints,
  resolveRange,
  type RangeInput,
} from './history/range.js';
import {
  computeStats,
  coverage,
  downsample,
  round,
  toChanges,
  type ValuePoint,
} from './history/shape.js';
import {
  describeHeatingSetup,
  findRoom,
  selectHome,
  summarizeDevices,
  toHomes,
  type Home,
  type Module,
} from './homes/topology.js';
import type {
  BoilerHistory,
  DeviceStatusView,
  DeviceView,
  HeatingStatusView,
  HistoryMode,
  HomeDetail,
  HomeRef,
  HomeStatusView,
  HomeSummary,
  RoomStatusView,
  RoomView,
  TemperatureHistory,
} from './views.js';

export interface CallOptions {
  signal?: AbortSignal;
}

export type { RangeInput };

export interface RoomRef {
  room_id?: string | undefined;
  room_name?: string | undefined;
}

export interface TemperatureHistoryInput extends RangeInput, RoomRef {
  home_id?: string | undefined;
  scale?: 'auto' | Scale | undefined;
  mode?: HistoryMode | undefined;
  max_points?: number | undefined;
}

export type BoilerScale = 'auto' | '1hour' | '3hours' | '1day' | '1week' | '1month';

export interface BoilerHistoryInput extends RangeInput {
  home_id?: string | undefined;
  scale?: BoilerScale | undefined;
  mode?: HistoryMode | undefined;
  max_points?: number | undefined;
}

/** Hard bounds keeping tool output small (ADR-0007). */
export const DEFAULT_AGGREGATED_POINTS = 48;
export const DEFAULT_DETAILED_POINTS = 200;
export const MAX_OUTPUT_POINTS = 1000;

export class EnergyService {
  private readonly clock: Clock;

  constructor(
    private readonly client: NetatmoClient,
    private readonly history: HistoryService,
    clock?: Clock,
  ) {
    this.clock = clock ?? systemClock;
  }

  private nowSeconds(): number {
    return Math.floor(this.clock.now() / 1000);
  }

  // ------------------------------------------------------------ discovery

  async listHomes(opts: CallOptions = {}): Promise<{ homes: HomeSummary[] }> {
    const homes = await this.homes(opts);
    return { homes: homes.map((h) => this.summary(h)) };
  }

  async getHome(homeId?: string, opts: CallOptions = {}): Promise<HomeDetail> {
    const home = await this.home(homeId, opts);
    return {
      ...this.summary(home),
      temperature_control_mode: home.temperatureControlMode,
      default_manual_duration_min: home.defaultManualDurationMin,
      schedules: home.schedules,
      rooms: home.rooms.map((r) => roomView(home, r.id)),
      devices: home.modules.map((m) => deviceView(home, m)),
    };
  }

  async listRooms(
    homeId?: string,
    opts: CallOptions = {},
  ): Promise<{ home: HomeRef; rooms: RoomView[] }> {
    const home = await this.home(homeId, opts);
    return { home: ref(home), rooms: home.rooms.map((r) => roomView(home, r.id)) };
  }

  async listDevices(
    homeId?: string,
    opts: CallOptions = {},
  ): Promise<{ home: HomeRef; devices: DeviceView[] }> {
    const home = await this.home(homeId, opts);
    return { home: ref(home), devices: home.modules.map((m) => deviceView(home, m)) };
  }

  // --------------------------------------------------------------- status

  async homeStatus(homeId?: string, opts: CallOptions = {}): Promise<HomeStatusView> {
    const { home, snap } = await this.snapshot(homeId, opts);
    const tz = zone(home);
    const rooms = home.rooms.map((r) => roomStatus(home, snap, r.id, tz));
    const alerts: string[] = [];
    for (const m of snap.modules) {
      const name = deviceLabel(home, m.moduleId);
      if (m.reachable === false) alerts.push(`${name} is unreachable.`);
      if (m.batteryState === 'low' || m.batteryState === 'very_low') {
        alerts.push(`${name} battery is ${m.batteryState.replace('_', ' ')}.`);
      }
    }
    for (const r of rooms)
      if (r.open_window) alerts.push(`Open window detected in ${r.room_name}.`);
    for (const e of snap.deviceErrors) {
      alerts.push(
        `Netatmo reports error code ${e.code} for ${e.id ? deviceLabel(home, e.id) : 'a device'}.`,
      );
    }
    return {
      home: ref(home),
      observed_at: formatIso(snap.observedAt / 1000, tz),
      heating_mode: home.thermMode,
      boiler_on: boilerOn(home, snap),
      rooms,
      alerts,
    };
  }

  async roomStatus(
    homeId: string | undefined,
    room: RoomRef,
    opts: CallOptions = {},
  ): Promise<{ home: HomeRef; observed_at: string; room: RoomStatusView }> {
    const { home, snap } = await this.snapshot(homeId, opts);
    const r = findRoom(home, roomRefArgs(room));
    const tz = zone(home);
    return {
      home: ref(home),
      observed_at: formatIso(snap.observedAt / 1000, tz),
      room: roomStatus(home, snap, r.id, tz),
    };
  }

  async heatingStatus(homeId?: string, opts: CallOptions = {}): Promise<HeatingStatusView> {
    const { home, snap } = await this.snapshot(homeId, opts);
    const tz = zone(home);
    const rooms = home.rooms.map((r) => roomStatus(home, snap, r.id, tz));
    const source = describeHeatingSetup(home).boilerSource;
    return {
      home: ref(home),
      observed_at: formatIso(snap.observedAt / 1000, tz),
      heating_mode: home.thermMode,
      boiler_on: boilerOn(home, snap),
      boiler_source: source?.thermostatType ?? null,
      rooms_requesting_heat: rooms.filter((r) => (r.heating_demand_percent ?? 0) > 0).length,
      rooms: rooms.map((r) => ({
        room_id: r.room_id,
        room_name: r.room_name,
        temperature_c: r.temperature_c,
        setpoint_c: r.setpoint_c,
        heating_demand_percent: r.heating_demand_percent,
        anticipating: r.anticipating,
        open_window: r.open_window,
      })),
      caveats: [
        'heating_demand_percent is the heat requested by a room, not boiler power or energy use.',
        'boiler_on reflects the thermostat request at observed_at, not burner activity over time.',
      ],
    };
  }

  async deviceStatus(
    homeId?: string,
    deviceId?: string,
    opts: CallOptions = {},
  ): Promise<{ home: HomeRef; observed_at: string; devices: DeviceStatusView[] }> {
    const { home, snap } = await this.snapshot(homeId, opts);
    const modules = deviceId ? home.modules.filter((m) => m.id === deviceId) : home.modules;
    if (deviceId && modules.length === 0) {
      throw new InvalidArgumentError(
        `No device with ID ${deviceId} in ${home.name}. Use netatmo_list_devices to see device IDs.`,
      );
    }
    return {
      home: ref(home),
      observed_at: formatIso(snap.observedAt / 1000, zone(home)),
      devices: modules.map((m) => deviceStatus(home, m, snap)),
    };
  }

  // -------------------------------------------------------------- history

  async temperatureHistory(
    input: TemperatureHistoryInput,
    measure: 'temperature' | 'setpoint',
    opts: CallOptions = {},
  ): Promise<TemperatureHistory> {
    const home = await this.home(input.home_id, opts);
    const room = findRoom(home, roomRefArgs(input));
    const tz = zone(home);
    const notes: string[] = [];
    if (!home.timezone) notes.push('The home time zone is unknown; times are shown in UTC.');

    const range = resolveRange(input, 'last_24h', tz, this.nowSeconds());
    const scale = chooseRoomScale(range, input.scale, notes);
    const step = SCALE_SECONDS[scale];
    const begin = alignBegin(range.begin, scale, tz);
    const series = await this.history.roomSeries(
      {
        homeId: home.id,
        roomId: room.id,
        scale,
        types: [measure === 'temperature' ? 'temperature' : 'sp_temperature'],
        range: { begin, end: range.end },
      },
      opts,
    );
    notes.push(...series.warnings);
    notes.push(`Each value covers one ${scale} bucket; times mark the start of the bucket.`);

    const points = valuePoints(series.points, 0);
    const mode = input.mode ?? 'aggregated';
    const out: TemperatureHistory = {
      home: ref(home),
      room: { id: room.id, name: room.name },
      measure,
      unit: '°C',
      range: { from: formatIso(begin, tz), to: formatIso(range.end, tz) },
      scale,
      mode,
      stats: computeStats(points, tz),
      coverage: coverage(
        expectedPoints(begin, range.end, scale),
        points.length,
        series.gaps,
        step,
        tz,
      ),
      requests: series.requests,
      notes,
      truncated: false,
    };
    if (points.length === 0) notes.push('Netatmo returned no data for this room and range.');

    const limit = clampPoints(input.max_points, mode);
    if (mode === 'aggregated') {
      out.buckets = downsample(points, limit, step, tz);
    } else if (mode === 'detailed') {
      out.truncated = points.length > limit;
      out.points = points
        .slice(0, limit)
        .map((p) => ({ time: formatIso(p.t, tz), value: round(p.v) }));
      if (out.truncated) {
        notes.push(
          `Only the first ${limit} of ${points.length} points are included; use mode "aggregated" or a shorter range.`,
        );
      }
    }
    if (measure === 'setpoint' && mode !== 'summary') {
      const changes = toChanges(points, step, tz);
      out.truncated ||= changes.length > limit;
      out.changes = changes.slice(0, limit);
    }
    return out;
  }

  async boilerHistory(input: BoilerHistoryInput, opts: CallOptions = {}): Promise<BoilerHistory> {
    const home = await this.home(input.home_id, opts);
    const tz = zone(home);
    const notes: string[] = [];
    const range = resolveRange(input, 'yesterday', tz, this.nowSeconds());
    const scale = boilerScale(range, input.scale, notes);
    const step = SCALE_SECONDS[scale];
    const daily = LARGE_SCALES.includes(scale);
    const begin = alignBegin(range.begin, scale, tz);
    const series = await this.history.boilerSeries(
      {
        home,
        scale,
        types: daily ? ['sum_boiler_on', 'sum_boiler_off'] : ['boileron', 'boileroff'],
        range: { begin, end: range.end },
      },
      opts,
    );
    notes.push(...series.warnings);

    const buckets: { from: number; to: number; on: number; duration: number }[] = [];
    series.points.forEach((p, i) => {
      const on = boilerOnSeconds(scale, p.values[0], p.values[1]);
      if (on === null) return;
      const next = series.points[i + 1]?.t;
      const to = daily ? bucketEnd(p.t, scale, tz, next) : p.t + step;
      const reported = daily && p.values[1] != null ? on + p.values[1] : to - p.t;
      buckets.push({ from: p.t, to, on, duration: Math.max(reported, on) });
    });
    const totalOn = buckets.reduce((n, b) => n + b.on, 0);
    const totalDuration = buckets.reduce((n, b) => n + b.duration, 0);
    const mode = input.mode ?? 'aggregated';
    const limit = clampPoints(input.max_points, mode);
    const source = describeHeatingSetup(home).boilerSource;

    const out: BoilerHistory = {
      home: ref(home),
      range: { from: formatIso(begin, tz), to: formatIso(range.end, tz) },
      scale,
      mode,
      thermostat_type: source?.thermostatType ?? 'unknown',
      total_heat_demand_minutes: round(totalOn / 60, 1),
      heat_demand_fraction: totalDuration > 0 ? round(totalOn / totalDuration, 3) : null,
      coverage: coverage(
        expectedPoints(begin, range.end, scale),
        buckets.length,
        series.gaps,
        step,
        tz,
      ),
      requests: series.requests,
      notes,
      truncated: false,
      caveats: [
        ...BOILER_CAVEATS,
        'Netatmo documents these measures in minutes, but live data shows seconds; they are converted here.',
      ],
    };
    if (buckets.length === 0) notes.push('Netatmo returned no boiler data for this range.');
    if (daily && buckets.length > 0) {
      notes.push('The last day may be incomplete if the range ends today.');
    }

    if (mode !== 'summary') {
      let view = buckets;
      if (mode === 'aggregated' && buckets.length > limit) {
        const size = Math.ceil(buckets.length / limit);
        view = [];
        for (let i = 0; i < buckets.length; i += size) {
          const g = buckets.slice(i, i + size);
          const head = g[0];
          const tail = g[g.length - 1];
          if (!head || !tail) continue;
          view.push({
            from: head.from,
            to: tail.to,
            on: g.reduce((n, b) => n + b.on, 0),
            duration: g.reduce((n, b) => n + b.duration, 0),
          });
        }
      } else if (mode === 'detailed' && buckets.length > limit) {
        out.truncated = true;
        view = buckets.slice(0, limit);
        notes.push(`Only the first ${limit} of ${buckets.length} buckets are included.`);
      }
      out.buckets = view.map((b) => ({
        from: formatIso(b.from, tz),
        to: formatIso(b.to, tz),
        heat_demand_minutes: round(b.on / 60, 1),
        fraction: b.duration > 0 ? round(b.on / b.duration, 3) : 0,
      }));
    }
    return out;
  }

  // ------------------------------------------------------------- internals

  private async homes(opts: CallOptions): Promise<Home[]> {
    return toHomes((await this.client.homesData({}, opts)).body);
  }

  private async home(homeId: string | undefined, opts: CallOptions): Promise<Home> {
    return selectHome(await this.homes(opts), homeId);
  }

  private async snapshot(
    homeId: string | undefined,
    opts: CallOptions,
  ): Promise<{ home: Home; snap: HomeSnapshot }> {
    const home = await this.home(homeId, opts);
    const status = await this.client.homeStatus(home.id, opts);
    return { home, snap: toHomeSnapshot(status.body, status.timeServer, this.clock.now()) };
  }

  private summary(home: Home): HomeSummary {
    return {
      ...ref(home),
      room_count: home.rooms.length,
      device_count: home.modules.length,
      device_summary: summarizeDevices(home),
      heating_mode: home.thermMode,
      boiler_history_available: describeHeatingSetup(home).boilerSource !== undefined,
    };
  }
}

// ---------------------------------------------------------------- helpers

export function zone(home: Home): string {
  return home.timezone ?? 'UTC';
}

export function ref(home: Home): HomeRef {
  return { id: home.id, name: home.name, timezone: zone(home) };
}

function roomRefArgs(r: RoomRef): { roomId?: string; roomName?: string } {
  return {
    ...(r.room_id !== undefined && { roomId: r.room_id }),
    ...(r.room_name !== undefined && { roomName: r.room_name }),
  };
}

function roomView(home: Home, roomId: string): RoomView {
  const room = home.rooms.find((r) => r.id === roomId);
  const devices = home.modules.filter((m) => room?.moduleIds.includes(m.id) || m.roomId === roomId);
  const ids = [...new Set(devices.map((m) => m.id))];
  return {
    id: roomId,
    name: room?.name ?? roomId,
    type: room?.type ?? null,
    device_ids: ids,
    device_types: [...new Set(devices.map((m) => m.type))],
  };
}

function deviceView(home: Home, m: Module): DeviceView {
  return {
    id: m.id,
    type: m.type,
    model: m.model,
    category: m.category,
    name: m.name,
    room_id: m.roomId,
    room_name: home.rooms.find((r) => r.id === m.roomId)?.name ?? null,
    bridge_id: m.bridgeId,
  };
}

function deviceLabel(home: Home, id: string): string {
  const m = home.modules.find((x) => x.id === id);
  if (!m) return `Device ${id}`;
  const room = home.rooms.find((r) => r.id === m.roomId)?.name;
  return `${m.name ?? m.model}${room ? ` (${room})` : ''}`;
}

function roomStatus(home: Home, snap: HomeSnapshot, roomId: string, tz: string): RoomStatusView {
  const room = home.rooms.find((r) => r.id === roomId);
  const s = snap.rooms.find((r) => r.roomId === roomId);
  const temp = s?.temperatureC ?? null;
  const setpoint = s?.setpointC ?? null;
  return {
    room_id: roomId,
    room_name: room?.name ?? roomId,
    room_type: room?.type ?? null,
    temperature_c: temp,
    setpoint_c: setpoint,
    difference_to_setpoint_c: temp !== null && setpoint !== null ? round(temp - setpoint, 1) : null,
    setpoint_mode: s?.setpointMode ?? null,
    setpoint_end: s?.setpointEndTime ? formatIso(s.setpointEndTime, tz) : null,
    heating_demand_percent: s?.heatingDemandPercent ?? null,
    open_window: s?.openWindow ?? null,
    anticipating: s?.anticipating ?? null,
    reachable: s?.reachable ?? null,
  };
}

function boilerOn(home: Home, snap: HomeSnapshot): boolean | null {
  const thermostats = new Set(describeHeatingSetup(home).thermostats.map((m) => m.id));
  return (
    snap.modules.find((m) => thermostats.has(m.moduleId) && m.boilerOn !== null)?.boilerOn ?? null
  );
}

export function rfQuality(v: number | null): DeviceStatusView['rf_quality'] {
  if (v === null) return null;
  return v >= 90 ? 'low' : v >= 80 ? 'medium' : v >= 70 ? 'high' : 'full';
}

export function wifiQuality(v: number | null): DeviceStatusView['wifi_quality'] {
  if (v === null) return null;
  return v >= 86 ? 'poor' : v >= 71 ? 'average' : 'good';
}

function deviceStatus(home: Home, m: Module, snap: HomeSnapshot): DeviceStatusView {
  const s: ModuleSnapshot | undefined = snap.modules.find((x) => x.moduleId === m.id);
  return {
    ...deviceView(home, m),
    reachable: s?.reachable ?? null,
    battery_state: s?.batteryState ?? null,
    battery_level_mv: s?.batteryLevelMv ?? null,
    rf_strength: s?.rfStrength ?? null,
    rf_quality: rfQuality(s?.rfStrength ?? null),
    wifi_strength: s?.wifiStrength ?? null,
    wifi_quality: wifiQuality(s?.wifiStrength ?? null),
    firmware_revision: s?.firmwareRevision ?? null,
    boiler_on: m.category === 'thermostat' ? (s?.boilerOn ?? null) : null,
    error_codes: snap.deviceErrors.filter((e) => e.id === m.id).map((e) => e.code),
  };
}

function valuePoints(points: MeasurePoint[], index: number): ValuePoint[] {
  const out: ValuePoint[] = [];
  for (const p of points) {
    const v = p.values[index];
    if (v != null) out.push({ t: p.t, v });
  }
  return out;
}

function bucketEnd(t: number, scale: Scale, tz: string, next: number | undefined): number {
  if (scale === '1day') return addLocalDays(t, 1, tz);
  if (scale === '1week') return addLocalDays(t, 7, tz);
  return next ?? t + SCALE_SECONDS[scale];
}

function clampPoints(requested: number | undefined, mode: HistoryMode): number {
  const fallback = mode === 'detailed' ? DEFAULT_DETAILED_POINTS : DEFAULT_AGGREGATED_POINTS;
  return Math.min(MAX_OUTPUT_POINTS, Math.max(1, requested ?? fallback));
}

function boilerScale(
  range: { begin: number; end: number },
  requested: BoilerScale | undefined,
  notes: string[],
): Scale {
  if (requested && requested !== 'auto') return requested;
  const days = (range.end - range.begin) / 86_400;
  const chosen: Scale = days <= 2 ? '1hour' : days <= 93 ? '1day' : '1week';
  notes.push(`Scale "${chosen}" was chosen automatically for this range.`);
  return chosen;
}
