/**
 * Pure analysis helpers for `probe`: they answer the open questions of
 * docs/api-capabilities.md §10 from recorded responses, without exposing identifiers.
 */
import type { MeasurePoint } from '../netatmo/measures.js';
import { boilerOnSeconds } from '../domain/heating/boiler.js';
import { formatLocal } from '../utils/dates.js';

export function sortedKeys(objects: unknown[]): string[] {
  const keys = new Set<string>();
  for (const o of objects) {
    if (o && typeof o === 'object' && !Array.isArray(o))
      for (const k of Object.keys(o)) keys.add(k);
  }
  return [...keys].sort();
}

/** Union of field names per module type in a raw homestatus/homesdata modules array. */
export function keysByType(modules: unknown[]): Record<string, string[]> {
  const groups = new Map<string, unknown[]>();
  for (const m of modules) {
    const type =
      m && typeof m === 'object' && typeof (m as { type?: unknown }).type === 'string'
        ? (m as { type: string }).type
        : '(no type)';
    groups.set(type, [...(groups.get(type) ?? []), m]);
  }
  return Object.fromEntries([...groups].map(([t, list]) => [t, sortedKeys(list)]));
}

const SPELLING_VARIANTS: [string, string][] = [
  ['open_window', 'open_windows'],
  ['rf_strength', 'rf_strenght'],
  ['wifi_strength', 'wifi_strenght'],
  ['modules_bridged', 'module_bridged'],
  ['therm_setpoint_default_duration', 'therm_set_point_default_duration'],
];

/** Which spelling of each known-ambiguous field actually appears. */
export function spellingReport(allKeys: Set<string>): string[] {
  return SPELLING_VARIANTS.map(([lib, spec]) => {
    const a = allKeys.has(lib);
    const b = allKeys.has(spec);
    const seen =
      a && b
        ? 'both'
        : a
          ? `"${lib}" (library spelling)`
          : b
            ? `"${spec}" (spec spelling)`
            : 'neither';
    return `${lib} / ${spec}: ${seen}`;
  });
}

export function describeMeasureShape(body: unknown): string {
  if (Array.isArray(body)) {
    if (body.length === 0) return 'empty array';
    const segs = body as { step_time?: unknown; value?: unknown[] }[];
    const noStep = segs.filter((s) => s.step_time === undefined).length;
    const values = segs.reduce((n, s) => n + (Array.isArray(s.value) ? s.value.length : 0), 0);
    return `segments (optimize=true shape): ${segs.length} segment(s), ${values} values, ${noStep} without step_time`;
  }
  if (body && typeof body === 'object') {
    const keys = Object.keys(body);
    if (keys.every((k) => /^\d+$/.test(k)))
      return `timestamp map (optimize=false shape): ${keys.length} entries`;
    return `OTHER shape with keys: ${keys.slice(0, 10).join(', ')}`;
  }
  return `unexpected body type: ${body === null ? 'null' : typeof body}`;
}

export interface Stats {
  n: number;
  min: number;
  median: number;
  max: number;
}

export function stats(values: number[]): Stats | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0] ?? 0,
    median: s[Math.floor(s.length / 2)] ?? 0,
    max: s[s.length - 1] ?? 0,
  };
}

export function formatStats(s: Stats | undefined): string {
  return s ? `n=${s.n}, min=${s.min}, median=${s.median}, max=${s.max}` : 'no data';
}

/** on + off per bucket. Observed: ≈ 600 (s per sample) sub-daily, ≈ 86 400 (s per day) daily. */
export function onOffSums(points: MeasurePoint[]): Stats | undefined {
  const sums = points
    .map((p) =>
      p.values[0] != null && p.values[1] != null ? p.values[0] + p.values[1] : undefined,
    )
    .filter((v): v is number => v !== undefined);
  return stats(sums);
}

/**
 * Compare heat-demand time derived from hourly boileron/boileroff with Σ sum_boiler_on from
 * daily data, over the days fully covered by both series. Agreement validates boilerOnSeconds().
 * Hourly buckets are anchored to the request start, so small edge differences are expected.
 */
export function compareHourlyWithDaily(
  hourly: MeasurePoint[],
  daily: MeasurePoint[],
): { days: number; hourlyMinutes: number; dailyMinutes: number } | undefined {
  if (hourly.length === 0 || daily.length < 2) return undefined;
  const first = hourly[0]?.t ?? 0;
  const last = hourly[hourly.length - 1]?.t ?? 0;
  let days = 0;
  let hourlySeconds = 0;
  let dailySeconds = 0;
  for (let i = 0; i < daily.length - 1; i++) {
    const start = daily[i]?.t ?? 0;
    const end = daily[i + 1]?.t ?? 0;
    const on = daily[i]?.values[0];
    if (start < first || end > last + 3600 || on == null) continue;
    days += 1;
    dailySeconds += on;
    for (const p of hourly) {
      if (p.t >= start && p.t < end)
        hourlySeconds += boilerOnSeconds('1hour', p.values[0], p.values[1]) ?? 0;
    }
  }
  return days === 0
    ? undefined
    : {
        days,
        hourlyMinutes: Math.round(hourlySeconds / 60),
        dailyMinutes: Math.round(dailySeconds / 60),
      };
}

/** Distinct (timestamp mod step) values and local times of the first few buckets. */
export function alignment(
  points: MeasurePoint[],
  stepSeconds: number,
  timeZone: string | null,
): string {
  if (points.length === 0) return 'no data';
  const mods = [
    ...new Set(points.map((p) => ((p.t % stepSeconds) + stepSeconds) % stepSeconds)),
  ].slice(0, 5);
  const local = timeZone
    ? points
        .slice(0, 3)
        .map((p) => formatLocal(p.t, timeZone))
        .join(', ')
    : '(no time zone)';
  return `t mod step = ${mods.join('/')} s; first buckets local time: ${local}`;
}
