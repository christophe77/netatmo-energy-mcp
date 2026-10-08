/**
 * Rule-based anomaly detection over temperature/setpoint samples (architecture §8, ADR-0009).
 * Findings describe what the data shows, with severity and confidence. They never diagnose
 * a cause or a device fault.
 */
import { round, type Sample } from './comfort.js';

export type AnomalyType =
  | 'out_of_range'
  | 'impossible_jump'
  | 'flatline'
  | 'missing_data'
  | 'rapid_drop'
  | 'sustained_below_setpoint'
  | 'sustained_above_setpoint';

export type Level = 'low' | 'medium' | 'high';

export interface Anomaly {
  type: AnomalyType;
  severity: Level;
  confidence: Level;
  /** Unix seconds. */
  start: number;
  end: number;
  evidence: Sample[];
  explanation: string;
}

export interface Thresholds {
  minPlausibleC: number;
  maxPlausibleC: number;
  /** Change between consecutive samples considered physically implausible indoors. */
  jumpC: number;
  flatlineHours: number;
  /** Minimum setpoint change during a flatline for it to be reported. */
  flatlineSetpointChangeC: number;
  /** Gaps longer than this many steps are reported. */
  missingSteps: number;
  rapidDropC: number;
  rapidDropWindowHours: number;
  belowSetpointC: number;
  belowSetpointHours: number;
  aboveSetpointC: number;
  aboveSetpointHours: number;
  /** Setpoints below this are frost protection/away/off and are not compared. */
  minActiveSetpointC: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  minPlausibleC: 0,
  maxPlausibleC: 40,
  jumpC: 5,
  flatlineHours: 12,
  flatlineSetpointChangeC: 1,
  missingSteps: 3,
  rapidDropC: 3,
  rapidDropWindowHours: 1,
  belowSetpointC: 2,
  belowSetpointHours: 3,
  aboveSetpointC: 3,
  aboveSetpointHours: 6,
  minActiveSetpointC: 12,
};

export interface GapInput {
  /** Last timestamp before the gap. */
  after: number;
  /** First timestamp after the gap. */
  before: number;
  missingPoints: number;
}

const fmt = (n: number) => `${round(n, 1)} °C`;
const hours = (s: number) => `${round(s / 3600, 1)} h`;

/** Pick up to `n` evenly spaced samples as evidence (always includes first and last). */
function evidence(samples: Sample[], n = 5): Sample[] {
  if (samples.length <= n) return samples;
  const out: Sample[] = [];
  for (let k = 0; k < n; k++) {
    const s = samples[Math.round((k * (samples.length - 1)) / (n - 1))];
    if (s) out.push(s);
  }
  return out;
}

/** Maximal runs of consecutive (contiguous in time) samples satisfying `pred`. */
function runs(samples: Sample[], stepSeconds: number, pred: (s: Sample) => boolean): Sample[][] {
  const out: Sample[][] = [];
  let cur: Sample[] = [];
  for (const s of samples) {
    const last = cur[cur.length - 1];
    if (pred(s) && (!last || s.t - last.t <= stepSeconds * 1.5)) {
      cur.push(s);
    } else {
      if (cur.length > 0) out.push(cur);
      cur = pred(s) ? [s] : [];
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

const span = (run: Sample[], stepSeconds: number) =>
  (run[run.length - 1]?.t ?? 0) - (run[0]?.t ?? 0) + stepSeconds;

export function detectAnomalies(
  samples: Sample[],
  stepSeconds: number,
  gaps: GapInput[] = [],
  th: Thresholds = DEFAULT_THRESHOLDS,
): Anomaly[] {
  const found: Anomaly[] = [];
  const withTemp = samples.filter((s) => s.temp !== null);

  // Out of plausible indoor range.
  for (const run of runs(
    withTemp,
    stepSeconds,
    (s) => s.temp !== null && (s.temp < th.minPlausibleC || s.temp > th.maxPlausibleC),
  )) {
    const values = run.map((s) => s.temp ?? 0);
    found.push({
      type: 'out_of_range',
      severity: 'high',
      confidence: 'high',
      start: run[0]?.t ?? 0,
      end: (run[run.length - 1]?.t ?? 0) + stepSeconds,
      evidence: evidence(run),
      explanation: `Temperature readings outside the plausible indoor range (${th.minPlausibleC}–${th.maxPlausibleC} °C): from ${fmt(Math.min(...values))} to ${fmt(Math.max(...values))}.`,
    });
  }

  // Implausible jumps between consecutive samples.
  for (let i = 1; i < withTemp.length; i++) {
    const a = withTemp[i - 1];
    const b = withTemp[i];
    if (!a || !b || a.temp === null || b.temp === null) continue;
    if (b.t - a.t > stepSeconds * 1.5) continue;
    const delta = b.temp - a.temp;
    if (Math.abs(delta) > th.jumpC) {
      found.push({
        type: 'impossible_jump',
        severity: 'high',
        confidence: 'medium',
        start: a.t,
        end: b.t + stepSeconds,
        evidence: [a, b],
        explanation: `Temperature changed by ${fmt(delta)} between two consecutive readings (${fmt(a.temp)} → ${fmt(b.temp)}), which is unusually fast for a room.`,
      });
    }
  }

  // Constant readings for a long time although the setpoint changed.
  let i = 0;
  while (i < withTemp.length) {
    const first = withTemp[i];
    let j = i;
    while (j + 1 < withTemp.length) {
      const next = withTemp[j + 1];
      const cur = withTemp[j];
      if (!next || !cur || next.temp !== first?.temp || next.t - cur.t > stepSeconds * 1.5) break;
      j++;
    }
    const run = withTemp.slice(i, j + 1);
    const setpoints = run.map((s) => s.setpoint).filter((v): v is number => v !== null);
    const spRange = setpoints.length ? Math.max(...setpoints) - Math.min(...setpoints) : 0;
    if (
      first &&
      span(run, stepSeconds) >= th.flatlineHours * 3600 &&
      spRange >= th.flatlineSetpointChangeC
    ) {
      found.push({
        type: 'flatline',
        severity: 'medium',
        confidence: 'low',
        start: first.t,
        end: (run[run.length - 1]?.t ?? first.t) + stepSeconds,
        evidence: evidence(run),
        explanation: `Temperature stayed exactly ${fmt(first.temp ?? 0)} for ${hours(span(run, stepSeconds))} while the setpoint varied by ${fmt(spRange)}. Constant readings can be normal in a very stable room, so confidence is low.`,
      });
    }
    i = j + 1;
  }

  // Missing data.
  for (const g of gaps) {
    if (g.missingPoints < th.missingSteps) continue;
    const duration = g.before - g.after - stepSeconds;
    found.push({
      type: 'missing_data',
      severity: duration >= 6 * 3600 ? 'medium' : 'low',
      confidence: 'high',
      start: g.after + stepSeconds,
      end: g.before,
      evidence: [],
      explanation: `No measurements for about ${hours(duration)} (${g.missingPoints} expected values missing).`,
    });
  }

  // Rapid drop while the setpoint stayed constant.
  const window = th.rapidDropWindowHours * 3600;
  for (let a = 0; a < withTemp.length; a++) {
    const s0 = withTemp[a];
    if (!s0 || s0.temp === null) continue;
    for (let b = a + 1; b < withTemp.length; b++) {
      const s1 = withTemp[b];
      if (!s1 || s1.temp === null || s1.t - s0.t > window) break;
      const segment = withTemp.slice(a, b + 1);
      const constantSetpoint = segment.every(
        (s) => s.setpoint !== null && s.setpoint === s0.setpoint,
      );
      if (constantSetpoint && s0.temp - s1.temp >= th.rapidDropC) {
        found.push({
          type: 'rapid_drop',
          severity: 'medium',
          confidence: 'low',
          start: s0.t,
          end: s1.t + stepSeconds,
          evidence: segment.length > 5 ? evidence(segment) : segment,
          explanation: `Temperature fell ${fmt(s0.temp - s1.temp)} in ${hours(s1.t - s0.t)} (${fmt(s0.temp)} → ${fmt(s1.temp)}) while the setpoint stayed at ${fmt(s0.setpoint ?? 0)}. Possible explanations include ventilation or an open window, but the data cannot confirm a cause.`,
        });
        a = b; // skip past this event
        break;
      }
    }
  }

  // Sustained deviation from the setpoint.
  const active = (s: Sample) =>
    s.temp !== null && s.setpoint !== null && s.setpoint >= th.minActiveSetpointC;
  const sustained = (
    type: 'sustained_below_setpoint' | 'sustained_above_setpoint',
    pred: (s: Sample) => boolean,
    minHours: number,
    severity: Level,
  ) => {
    for (const run of runs(samples, stepSeconds, (s) => active(s) && pred(s))) {
      const duration = span(run, stepSeconds);
      if (duration < minHours * 3600) continue;
      const diffs = run.map((s) => (s.temp ?? 0) - (s.setpoint ?? 0));
      const worst = type === 'sustained_below_setpoint' ? Math.min(...diffs) : Math.max(...diffs);
      found.push({
        type,
        severity,
        confidence: 'medium',
        start: run[0]?.t ?? 0,
        end: (run[run.length - 1]?.t ?? 0) + stepSeconds,
        evidence: evidence(run),
        explanation:
          type === 'sustained_below_setpoint'
            ? `Temperature stayed at least ${fmt(th.belowSetpointC)} below the setpoint for ${hours(duration)} (largest gap ${fmt(-worst)}).`
            : `Temperature stayed at least ${fmt(th.aboveSetpointC)} above the setpoint for ${hours(duration)} (largest excess ${fmt(worst)}).`,
      });
    }
  };
  sustained(
    'sustained_below_setpoint',
    (s) => (s.temp ?? 0) <= (s.setpoint ?? 0) - th.belowSetpointC,
    th.belowSetpointHours,
    'medium',
  );
  sustained(
    'sustained_above_setpoint',
    (s) => (s.temp ?? 0) >= (s.setpoint ?? 0) + th.aboveSetpointC,
    th.aboveSetpointHours,
    'low',
  );

  const rank: Record<Level, number> = { high: 0, medium: 1, low: 2 };
  return found.sort((x, y) => rank[x.severity] - rank[y.severity] || x.start - y.start);
}
