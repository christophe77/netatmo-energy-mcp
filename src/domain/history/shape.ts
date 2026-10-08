/**
 * Pure helpers that turn raw series into bounded, LLM-friendly output (ADR-0007).
 * They never interpolate or invent values.
 */
import type { Gap } from '../../netatmo/measures.js';
import { formatIso } from '../../utils/dates.js';
import type { Bucket, Coverage, Stats } from '../views.js';

export interface ValuePoint {
  /** Unix seconds (bucket start). */
  t: number;
  v: number;
}

export const round = (n: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

export function computeStats(points: ValuePoint[], tz: string): Stats | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  let min = first;
  let max = first;
  let sum = 0;
  for (const p of points) {
    if (p.v < min.v) min = p;
    if (p.v > max.v) max = p;
    sum += p.v;
  }
  const mean = sum / points.length;
  const variance = points.reduce((acc, p) => acc + (p.v - mean) ** 2, 0) / points.length;
  return {
    count: points.length,
    min: round(min.v),
    min_time: formatIso(min.t, tz),
    max: round(max.v),
    max_time: formatIso(max.t, tz),
    mean: round(mean),
    stddev: round(Math.sqrt(variance)),
    first: round(first.v),
    last: round(last.v),
  };
}

/**
 * Group consecutive points into at most `maxBuckets` buckets of equal point count.
 * `stepSeconds` is used for the end of the last point's bucket.
 */
export function downsample(
  points: ValuePoint[],
  maxBuckets: number,
  stepSeconds: number,
  tz: string,
): Bucket[] {
  if (points.length === 0) return [];
  const size = Math.max(1, Math.ceil(points.length / Math.max(1, maxBuckets)));
  const out: Bucket[] = [];
  for (let i = 0; i < points.length; i += size) {
    const chunk = points.slice(i, i + size);
    const head = chunk[0];
    const tail = chunk[chunk.length - 1];
    if (!head || !tail) continue;
    const values = chunk.map((p) => p.v);
    out.push({
      from: formatIso(head.t, tz),
      to: formatIso(tail.t + stepSeconds, tz),
      min: round(Math.min(...values)),
      mean: round(values.reduce((a, b) => a + b, 0) / values.length),
      max: round(Math.max(...values)),
      count: values.length,
    });
  }
  return out;
}

/** Merge consecutive equal values (e.g. setpoints) into periods; a data gap ends a period. */
export function toChanges(
  points: ValuePoint[],
  stepSeconds: number,
  tz: string,
): { from: string; to: string; value: number }[] {
  const out: { from: number; to: number; value: number }[] = [];
  for (const p of points) {
    const cur = out[out.length - 1];
    if (cur && cur.value === p.v && p.t - cur.to <= stepSeconds * 0.5) {
      cur.to = p.t + stepSeconds;
    } else {
      out.push({ from: p.t, to: p.t + stepSeconds, value: p.v });
    }
  }
  return out.map((c) => ({
    from: formatIso(c.from, tz),
    to: formatIso(c.to, tz),
    value: round(c.value),
  }));
}

export const MAX_REPORTED_GAPS = 20;

export function coverage(
  expectedPoints: number,
  receivedPoints: number,
  gaps: Gap[],
  stepSeconds: number,
  tz: string,
): Coverage {
  return {
    expected_points: expectedPoints,
    received_points: receivedPoints,
    gaps: gaps.slice(0, MAX_REPORTED_GAPS).map((g) => ({
      from: formatIso(g.after + stepSeconds, tz),
      to: formatIso(g.before, tz),
      missing_points: g.missingPoints,
    })),
    gaps_truncated: gaps.length > MAX_REPORTED_GAPS,
  };
}
