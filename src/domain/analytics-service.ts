/**
 * Heating analytics (Phase 5): deterministic metrics computed from room history.
 * Uses the pure functions in src/analytics; independent of MCP.
 */
import { DEFAULT_THRESHOLDS, detectAnomalies } from '../analytics/anomalies.js';
import {
  cooldownRate,
  largestDrop,
  MIN_ACTIVE_SETPOINT_C,
  round,
  timeVsTarget,
  type Sample,
} from '../analytics/comfort.js';
import { AppError, InvalidArgumentError } from '../errors.js';
import type { NetatmoClient } from '../netatmo/client.js';
import { SCALE_SECONDS, type Scale } from '../netatmo/endpoints.js';
import { systemClock, type Clock } from '../utils/clock.js';
import { formatIso, type Period } from '../utils/dates.js';
import {
  ref,
  zone,
  type CallOptions,
  type EnergyService,
  type RangeInput,
} from './energy-service.js';
import type { HistoryService, Series } from './history/history-service.js';
import { computeStats } from './history/shape.js';
import {
  alignBegin,
  chooseRoomScale,
  expectedPoints,
  resolveRange,
  type Range,
} from './history/range.js';
import { findRoom, selectHome, toHomes, type Home, type Room } from './homes/topology.js';
import type {
  AnomalyReport,
  AnomalyView,
  HeatingSummary,
  RoomAnalysis,
  RoomComparison,
} from './views.js';

export interface AnalyticsInput extends RangeInput {
  home_id?: string | undefined;
  room_id?: string | undefined;
  room_name?: string | undefined;
}

export interface AnomalyInput extends AnalyticsInput {
  max_anomalies?: number | undefined;
}

export const ANOMALY_MAX_DAYS = 14;
export const DEFAULT_MAX_ANOMALIES = 30;

const COMMON_CAVEATS = [
  'Outdoor temperature is not available from Netatmo Energy, so differences between days or rooms may reflect the weather.',
  `Setpoints below ${MIN_ACTIVE_SETPOINT_C} °C (frost protection, away, off) are excluded from target comparisons.`,
];

interface RoomData {
  room: Room;
  series: Series;
  samples: Sample[];
}

export class AnalyticsService {
  private readonly clock: Clock;

  constructor(
    private readonly client: NetatmoClient,
    private readonly history: HistoryService,
    private readonly energy: EnergyService,
    clock?: Clock,
  ) {
    this.clock = clock ?? systemClock;
  }

  /** Per-room comfort metrics plus boiler heat-demand time over a period (default yesterday). */
  async heatingSummary(input: AnalyticsInput, opts: CallOptions = {}): Promise<HeatingSummary> {
    const home = await this.home(input.home_id, opts);
    const tz = zone(home);
    const notes: string[] = [];
    const range = resolveRange(input, 'yesterday', tz, this.now());
    const scale = chooseRoomScale(range, 'auto', notes);
    const rooms = this.selectRooms(home, input);
    const { data, requests } = await this.load(home, rooms, range, scale, opts);
    const analyses = data.map((d) => this.analyse(d, range, scale, tz));

    let boiler: HeatingSummary['boiler'] = {
      available: false,
      total_heat_demand_minutes: null,
      heat_demand_fraction: null,
      note: null,
    };
    let boilerRequests = 0;
    try {
      const b = await this.energy.boilerHistory(
        { home_id: home.id, ...rangeArgs(input), mode: 'summary' },
        opts,
      );
      boilerRequests = b.requests;
      boiler = {
        available: true,
        total_heat_demand_minutes: b.total_heat_demand_minutes,
        heat_demand_fraction: b.heat_demand_fraction,
        note: 'Heat-demand time: when the thermostat requested heat. Not gas or energy consumption.',
      };
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'UNSUPPORTED_CAPABILITY') throw error;
      boiler.note = 'No Netatmo thermostat in this home: boiler activity is not available.';
    }

    const means = analyses
      .map((a) => a.temperature?.mean)
      .filter((v): v is number => v !== undefined);
    return {
      home: ref(home),
      range: { from: formatIso(range.begin, tz), to: formatIso(range.end, tz) },
      scale,
      overall: {
        rooms_analysed: analyses.length,
        mean_temperature_c: means.length
          ? round(means.reduce((a, b) => a + b, 0) / means.length)
          : null,
        total_below_target_minutes: sum(analyses.map((a) => a.time_vs_target.below_minutes)),
        total_above_target_minutes: sum(analyses.map((a) => a.time_vs_target.above_minutes)),
      },
      boiler,
      rooms: analyses,
      requests: requests + boilerRequests,
      notes,
      caveats: COMMON_CAVEATS,
    };
  }

  /** Compare rooms over a period (default last 7 days) and rank them on several metrics. */
  async compareRooms(input: AnalyticsInput, opts: CallOptions = {}): Promise<RoomComparison> {
    const home = await this.home(input.home_id, opts);
    const tz = zone(home);
    const notes: string[] = [];
    const range = resolveRange(input, 'last_7d', tz, this.now());
    const scale = chooseRoomScale(range, 'auto', notes);
    const { data, requests } = await this.load(home, home.rooms, range, scale, opts);
    const rooms = data.map((d) => this.analyse(d, range, scale, tz));

    const rank = (
      metric: string,
      description: string,
      value: (a: RoomAnalysis) => number | null | undefined,
      descending = true,
    ) => ({
      metric,
      description,
      order: rooms
        .map((a) => ({ room_name: a.room_name, value: value(a) }))
        .filter((r): r is { room_name: string; value: number } => typeof r.value === 'number')
        .sort((x, y) => (descending ? y.value - x.value : x.value - y.value)),
    });

    return {
      home: ref(home),
      range: { from: formatIso(range.begin, tz), to: formatIso(range.end, tz) },
      scale,
      rooms,
      rankings: [
        rank('warmest', 'Mean temperature (°C), highest first', (a) => a.temperature?.mean),
        rank('coolest', 'Mean temperature (°C), lowest first', (a) => a.temperature?.mean, false),
        rank('most_variable', 'Temperature standard deviation (°C)', (a) => a.temperature?.stddev),
        rank('most_time_below_target', 'Minutes more than 0.5 °C below the setpoint', (a) =>
          a.time_vs_target.evaluated_minutes > 0 ? a.time_vs_target.below_minutes : null,
        ),
        rank('largest_drop', 'Largest drop within 3 h (°C)', (a) => a.largest_drop?.drop_c ?? 0),
        rank(
          'fastest_cooldown',
          'Median cool-down rate after setpoint decreases (°C/h)',
          (a) => a.cooldown.median_rate_c_per_hour,
        ),
      ],
      requests,
      notes,
      caveats: [
        ...COMMON_CAVEATS,
        'Cool-down rates depend on outdoor temperature, room size, exposure and residual radiator heat; compare them only within the same period.',
      ],
    };
  }

  /** Rule-based anomaly detection on 30-minute data (default last 24 h, at most 14 days). */
  async detectAnomalies(input: AnomalyInput, opts: CallOptions = {}): Promise<AnomalyReport> {
    const home = await this.home(input.home_id, opts);
    const tz = zone(home);
    const notes: string[] = [];
    const range = resolveRange(input, 'last_24h', tz, this.now(), ANOMALY_MAX_DAYS);
    const scale: Scale = '30min';
    const step = SCALE_SECONDS[scale];
    const rooms = this.selectRooms(home, input);
    const { data, requests } = await this.load(home, rooms, range, scale, opts);

    const all: AnomalyView[] = [];
    for (const d of data) {
      for (const a of detectAnomalies(d.samples, step, d.series.gaps)) {
        all.push({
          type: a.type,
          severity: a.severity,
          confidence: a.confidence,
          room_id: d.room.id,
          room_name: d.room.name,
          start: formatIso(a.start, tz),
          end: formatIso(a.end, tz),
          explanation: a.explanation,
          evidence: a.evidence.map((s) => ({
            time: formatIso(s.t, tz),
            temperature_c: s.temp,
            setpoint_c: s.setpoint,
          })),
        });
      }
    }
    const order = { high: 0, medium: 1, low: 2 };
    all.sort((x, y) => order[x.severity] - order[y.severity] || x.start.localeCompare(y.start));
    const limit = Math.min(100, Math.max(1, input.max_anomalies ?? DEFAULT_MAX_ANOMALIES));
    if (all.length === 0) notes.push('No anomalies matched the rules for this period.');

    return {
      home: ref(home),
      range: { from: formatIso(range.begin, tz), to: formatIso(range.end, tz) },
      scale,
      rooms_analysed: data.map((d) => d.room.name),
      anomaly_count: all.length,
      anomalies: all.slice(0, limit),
      truncated: all.length > limit,
      requests,
      notes: [
        ...notes,
        `Rules: out of ${DEFAULT_THRESHOLDS.minPlausibleC}–${DEFAULT_THRESHOLDS.maxPlausibleC} °C; jumps > ${DEFAULT_THRESHOLDS.jumpC} °C between readings; identical readings ≥ ${DEFAULT_THRESHOLDS.flatlineHours} h while the setpoint changed; gaps ≥ ${DEFAULT_THRESHOLDS.missingSteps} readings; drops ≥ ${DEFAULT_THRESHOLDS.rapidDropC} °C within ${DEFAULT_THRESHOLDS.rapidDropWindowHours} h at a constant setpoint; ≥ ${DEFAULT_THRESHOLDS.belowSetpointC} °C below setpoint for ≥ ${DEFAULT_THRESHOLDS.belowSetpointHours} h; ≥ ${DEFAULT_THRESHOLDS.aboveSetpointC} °C above for ≥ ${DEFAULT_THRESHOLDS.aboveSetpointHours} h.`,
      ],
      caveats: [
        'Anomalies describe unusual data, not confirmed faults. Explanations list possibilities only.',
        ...COMMON_CAVEATS,
      ],
    };
  }

  // ------------------------------------------------------------- internals

  private now(): number {
    return Math.floor(this.clock.now() / 1000);
  }

  private async home(homeId: string | undefined, opts: CallOptions): Promise<Home> {
    return selectHome(toHomes((await this.client.homesData({}, opts)).body), homeId);
  }

  private selectRooms(home: Home, input: AnalyticsInput): Room[] {
    if (input.room_id || input.room_name) {
      return [
        findRoom(home, {
          ...(input.room_id !== undefined && { roomId: input.room_id }),
          ...(input.room_name !== undefined && { roomName: input.room_name }),
        }),
      ];
    }
    if (home.rooms.length === 0) throw new InvalidArgumentError(`${home.name} has no rooms.`);
    return home.rooms;
  }

  /** Fetch temperature + setpoint for each room in one request per room (sequential). */
  private async load(
    home: Home,
    rooms: Room[],
    range: Range,
    scale: Scale,
    opts: CallOptions,
  ): Promise<{ data: RoomData[]; requests: number }> {
    const tz = zone(home);
    const begin = alignBegin(range.begin, scale, tz);
    const data: RoomData[] = [];
    let requests = 0;
    for (const room of rooms) {
      const series = await this.history.roomSeries(
        {
          homeId: home.id,
          roomId: room.id,
          scale,
          types: ['temperature', 'sp_temperature'],
          range: { begin, end: range.end },
        },
        opts,
      );
      requests += series.requests;
      data.push({
        room,
        series,
        samples: series.points.map((p) => ({
          t: p.t,
          temp: p.values[0] ?? null,
          setpoint: p.values[1] ?? null,
        })),
      });
    }
    return { data, requests };
  }

  private analyse(d: RoomData, range: Range, scale: Scale, tz: string): RoomAnalysis {
    const step = SCALE_SECONDS[scale];
    const temps = d.samples
      .filter((s): s is Sample & { temp: number } => s.temp !== null)
      .map((s) => ({ t: s.t, v: s.temp }));
    const stats = computeStats(temps, tz);
    const activeSetpoints = d.samples
      .map((s) => s.setpoint)
      .filter((v): v is number => v !== null && v >= MIN_ACTIVE_SETPOINT_C);
    const expected = expectedPoints(d.series.range.begin, range.end, scale);
    const drop = largestDrop(d.samples);
    return {
      room_id: d.room.id,
      room_name: d.room.name,
      room_type: d.room.type,
      coverage_percent: expected > 0 ? round((100 * temps.length) / expected, 1) : null,
      temperature: stats
        ? { mean: stats.mean, min: stats.min, max: stats.max, stddev: stats.stddev }
        : null,
      setpoint_mean_c: activeSetpoints.length
        ? round(activeSetpoints.reduce((a, b) => a + b, 0) / activeSetpoints.length)
        : null,
      time_vs_target: timeVsTarget(d.samples, step),
      largest_drop: drop
        ? {
            drop_c: drop.drop_c,
            from: formatIso(drop.from, tz),
            to: formatIso(drop.to, tz),
            from_c: drop.from_c,
            to_c: drop.to_c,
            rate_c_per_hour: drop.rate_c_per_hour,
          }
        : null,
      cooldown: cooldownRate(d.samples, step),
    };
  }
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function rangeArgs(input: RangeInput): { period?: Period; from?: string; to?: string } {
  return {
    ...(input.period !== undefined && { period: input.period }),
    ...(input.from !== undefined && { from: input.from }),
    ...(input.to !== undefined && { to: input.to }),
  };
}
