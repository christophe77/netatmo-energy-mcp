/**
 * Deterministic room comfort metrics (ADR-0009). Pure functions over aligned
 * temperature/setpoint samples; no I/O, no interpolation, no LLM.
 */

export interface Sample {
  /** Unix seconds, bucket start. */
  t: number;
  /** Measured temperature (°C) or null when Netatmo reported none. */
  temp: number | null;
  /** Setpoint (°C) or null. */
  setpoint: number | null;
}

/**
 * Setpoints below this are treated as frost protection / away / off, where "below or above
 * target" is not meaningful. Those samples are excluded and reported as such.
 */
export const MIN_ACTIVE_SETPOINT_C = 12;
export const DEFAULT_TARGET_TOLERANCE_C = 0.5;

const isActive = (s: Sample): s is Sample & { temp: number; setpoint: number } =>
  s.temp !== null && s.setpoint !== null && s.setpoint >= MIN_ACTIVE_SETPOINT_C;

export interface TimeVsTarget {
  evaluated_minutes: number;
  below_minutes: number;
  within_minutes: number;
  above_minutes: number;
  /** Samples without data or with a frost-protection/away/off setpoint. */
  excluded_minutes: number;
  /** Mean of (temperature − setpoint) over evaluated samples. */
  mean_difference_c: number | null;
}

/** Time below, within (±tolerance) and above target. Each sample counts for one step. */
export function timeVsTarget(
  samples: Sample[],
  stepSeconds: number,
  tolerance = DEFAULT_TARGET_TOLERANCE_C,
): TimeVsTarget {
  const stepMin = stepSeconds / 60;
  let below = 0;
  let within = 0;
  let above = 0;
  let excluded = 0;
  let diffSum = 0;
  for (const s of samples) {
    if (!isActive(s)) {
      excluded += stepMin;
      continue;
    }
    const diff = s.temp - s.setpoint;
    diffSum += diff;
    if (diff < -tolerance) below += stepMin;
    else if (diff > tolerance) above += stepMin;
    else within += stepMin;
  }
  const evaluated = below + within + above;
  return {
    evaluated_minutes: evaluated,
    below_minutes: below,
    within_minutes: within,
    above_minutes: above,
    excluded_minutes: excluded,
    mean_difference_c: evaluated > 0 ? round(diffSum / (evaluated / stepMin), 2) : null,
  };
}

export interface Drop {
  drop_c: number;
  from: number;
  to: number;
  from_c: number;
  to_c: number;
  rate_c_per_hour: number;
}

/** Largest temperature decrease within any window of `windowSeconds` (default 3 h). */
export function largestDrop(samples: Sample[], windowSeconds = 3 * 3600): Drop | null {
  const pts = samples.filter((s): s is Sample & { temp: number } => s.temp !== null);
  let best: Drop | null = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    if (!a) continue;
    for (let j = i + 1; j < pts.length; j++) {
      const b = pts[j];
      if (!b || b.t - a.t > windowSeconds) break;
      const drop = a.temp - b.temp;
      if (drop > (best?.drop_c ?? 0)) {
        best = {
          drop_c: round(drop, 2),
          from: a.t,
          to: b.t,
          from_c: a.temp,
          to_c: b.temp,
          rate_c_per_hour: round(drop / ((b.t - a.t) / 3600), 2),
        };
      }
    }
  }
  return best && best.drop_c >= 0.5 ? best : null;
}

export interface Cooldown {
  events: number;
  median_rate_c_per_hour: number | null;
}

/**
 * Cool-down rate after a setpoint decrease of at least 1 °C (e.g. night setback), while the
 * room is still above its new setpoint: temperature change over up to 2 h, in °C/h.
 * Ignores events with less than 1 h of data. Outdoor temperature is unknown, so rates are
 * only comparable between rooms over the same period.
 */
export function cooldownRate(samples: Sample[], stepSeconds: number): Cooldown {
  const rates: number[] = [];
  const contiguous = stepSeconds * 1.5;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const start = samples[i];
    if (
      !prev ||
      !start ||
      start.temp === null ||
      start.setpoint === null ||
      prev.setpoint === null
    ) {
      continue;
    }
    if (start.setpoint > prev.setpoint - 1 || start.temp <= start.setpoint + 0.5) continue;
    let end = start;
    for (let j = i + 1; j < samples.length; j++) {
      const s = samples[j];
      const before = samples[j - 1];
      if (!s || !before || s.t - before.t > contiguous || s.temp === null) break;
      if (s.setpoint !== start.setpoint || s.t - start.t > 2 * 3600) break;
      end = s;
      if (s.temp <= s.setpoint) break;
    }
    const hours = (end.t - start.t) / 3600;
    if (hours >= 1 && end.temp !== null) rates.push((start.temp - end.temp) / hours);
  }
  return {
    events: rates.length,
    median_rate_c_per_hour: rates.length ? round(median(rates), 2) : null,
  };
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
