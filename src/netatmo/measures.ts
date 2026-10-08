import { InvalidResponseError } from '../errors.js';
import { measureMapSchema, measureSegmentsSchema } from './schemas.js';

export interface MeasurePoint {
  /** Unix seconds, as returned by Netatmo. */
  t: number;
  /** One value per requested measure type, in request order. `null` = no value. */
  values: (number | null)[];
}

export interface DecodedMeasures {
  points: MeasurePoint[];
  shape: 'segments' | 'map' | 'empty';
  /** Non-fatal oddities worth surfacing (e.g. missing step_time on a multi-value segment). */
  warnings: string[];
}

/**
 * Decode a getroommeasure/getmeasure `body` in either documented shape.
 * Points are returned sorted by time and de-duplicated (first occurrence wins).
 */
export function decodeMeasureBody(
  body: unknown,
  typeCount: number,
  fallbackStepSeconds: number,
): DecodedMeasures {
  const warnings: string[] = [];
  let points: MeasurePoint[];
  let shape: DecodedMeasures['shape'];

  if (body === undefined || body === null || (Array.isArray(body) && body.length === 0)) {
    return { points: [], shape: 'empty', warnings };
  }

  const segments = measureSegmentsSchema.safeParse(body);
  if (segments.success) {
    shape = 'segments';
    points = [];
    for (const seg of segments.data) {
      let step = seg.step_time ?? undefined;
      if (step === undefined && seg.value.length > 1) {
        step = fallbackStepSeconds;
        warnings.push(
          `A segment with ${seg.value.length} values had no step_time; assumed ${fallbackStepSeconds} s.`,
        );
      }
      seg.value.forEach((row, i) => {
        points.push({ t: seg.beg_time + i * (step ?? 0), values: normaliseRow(row, typeCount) });
      });
    }
  } else {
    const map = measureMapSchema.safeParse(body);
    if (!map.success || Array.isArray(body)) {
      throw new InvalidResponseError('Unrecognised measure response shape from Netatmo.');
    }
    shape = 'map';
    points = Object.entries(map.data).map(([ts, row]) => ({
      t: Number(ts),
      values: normaliseRow(row, typeCount),
    }));
    if (points.some((p) => !Number.isFinite(p.t))) {
      throw new InvalidResponseError('Measure response contained a non-numeric timestamp key.');
    }
  }

  return { points: dedupeAndSort(points), shape, warnings };
}

function normaliseRow(row: (number | null)[], typeCount: number): (number | null)[] {
  const out = row.slice(0, typeCount);
  while (out.length < typeCount) out.push(null);
  return out;
}

export function dedupeAndSort(points: MeasurePoint[]): MeasurePoint[] {
  const seen = new Map<number, MeasurePoint>();
  for (const p of points) if (!seen.has(p.t)) seen.set(p.t, p);
  return [...seen.values()].sort((a, b) => a.t - b.t);
}

export interface Gap {
  /** Last timestamp before the gap (Unix s). */
  after: number;
  /** First timestamp after the gap (Unix s). */
  before: number;
  /** Number of expected points missing (approximate for variable steps). */
  missingPoints: number;
}

/**
 * Report intervals longer than 1.5 × step between consecutive points. Never fills them.
 * Also reports missing data at the start/end of the requested range.
 */
export function findGaps(
  points: MeasurePoint[],
  stepSeconds: number,
  range?: { begin: number; end: number },
): Gap[] {
  const gaps: Gap[] = [];
  const threshold = stepSeconds * 1.5;
  const push = (after: number, before: number) => {
    const missing = Math.round((before - after) / stepSeconds) - 1;
    if (missing > 0) gaps.push({ after, before, missingPoints: missing });
  };
  if (range && points.length === 0) {
    push(range.begin - stepSeconds, range.end + stepSeconds);
    return gaps;
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (range && first && first.t - range.begin > threshold) push(range.begin - stepSeconds, first.t);
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (prev && cur && cur.t - prev.t > threshold) push(prev.t, cur.t);
  }
  if (range && last && range.end - last.t > threshold) push(last.t, range.end + stepSeconds);
  return gaps;
}
