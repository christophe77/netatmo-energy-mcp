import { describe, expect, it } from 'vitest';
import { detectAnomalies } from '../../src/analytics/anomalies.js';
import {
  cooldownRate,
  largestDrop,
  median,
  timeVsTarget,
  type Sample,
} from '../../src/analytics/comfort.js';

const STEP = 1800;
/** Build half-hourly samples from [temp, setpoint] pairs. */
const series = (rows: [number | null, number | null][], start = 0): Sample[] =>
  rows.map(([temp, setpoint], i) => ({ t: start + i * STEP, temp, setpoint }));
const repeat = (n: number, row: [number | null, number | null]) =>
  Array.from({ length: n }, () => row);

describe('timeVsTarget', () => {
  it('splits time into below / within / above, excluding frost-protection setpoints and gaps', () => {
    const res = timeVsTarget(
      series([
        [18, 20], // below
        [19.6, 20], // within (±0.5)
        [20.4, 20], // within
        [21, 20], // above
        [15, 7], // hg setpoint → excluded
        [null, 20], // no data → excluded
      ]),
      STEP,
    );
    expect(res).toEqual({
      evaluated_minutes: 120,
      below_minutes: 30,
      within_minutes: 60,
      above_minutes: 30,
      excluded_minutes: 60,
      mean_difference_c: -0.25,
    });
  });

  it('returns a null mean difference when nothing can be evaluated', () => {
    expect(timeVsTarget(series([[null, null]]), STEP).mean_difference_c).toBeNull();
  });
});

describe('largestDrop', () => {
  it('finds the largest decrease within the window', () => {
    const drop = largestDrop(
      series([
        [20, 19],
        [20.5, 19],
        [19, 19],
        [18, 19],
        [21, 19],
      ]),
    );
    expect(drop).toMatchObject({ drop_c: 2.5, from: STEP, to: 3 * STEP, rate_c_per_hour: 2.5 });
  });

  it('ignores drops outside the window and tiny drops', () => {
    expect(
      largestDrop(
        series([
          [20, 19],
          [19.8, 19],
        ]),
      ),
    ).toBeNull();
    const far = [...series([[22, 19]]), { t: 4 * 3600, temp: 15, setpoint: 19 }];
    expect(largestDrop(far)).toBeNull();
  });
});

describe('cooldownRate', () => {
  it('measures °C/h after a setpoint decrease while the room is above the new setpoint', () => {
    const rows: [number, number][] = [
      [21, 21],
      [21, 17], // setback
      [20.5, 17],
      [20, 17],
      [19.5, 17],
      [19, 17], // 2 h after the setback
      [18.8, 17],
    ];
    expect(cooldownRate(series(rows), STEP)).toEqual({ events: 1, median_rate_c_per_hour: 1 });
  });

  it('ignores setpoint increases and short events', () => {
    expect(
      cooldownRate(
        series([
          [18, 17],
          [18, 21],
          [19, 21],
        ]),
        STEP,
      ).events,
    ).toBe(0);
    expect(
      cooldownRate(
        series([
          [21, 21],
          [21, 17],
          [16, 17],
        ]),
        STEP,
      ).events,
    ).toBe(0);
  });

  it('computes medians', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe('detectAnomalies', () => {
  const types = (s: Sample[], gaps = []) => detectAnomalies(s, STEP, gaps).map((a) => a.type);

  it('reports nothing for an ordinary day', () => {
    const day = series(
      Array.from(
        { length: 48 },
        (_, i) => [19.5 + Math.sin(i / 8) * 0.6, 19.5] as [number, number],
      ),
    );
    expect(types(day)).toEqual([]);
  });

  it('flags out-of-range values and implausible jumps', () => {
    const res = detectAnomalies(
      series([
        [20, 19],
        [45, 19],
        [20, 19],
        [19.8, 19],
      ]),
      STEP,
    );
    // High-severity findings first (by time), then the drop back from the spike.
    expect(res.map((a) => a.type)).toEqual([
      'impossible_jump',
      'out_of_range',
      'impossible_jump',
      'rapid_drop',
    ]);
    expect(res.find((a) => a.type === 'out_of_range')).toMatchObject({
      severity: 'high',
      confidence: 'high',
    });
  });

  it('flags a rapid drop with a constant setpoint, without claiming a cause', () => {
    const res = detectAnomalies(
      series([
        [21, 20],
        [19.5, 20],
        [17.8, 20],
        [18, 20],
      ]),
      STEP,
    );
    const drop = res.find((a) => a.type === 'rapid_drop')!;
    expect(drop).toMatchObject({ severity: 'medium', confidence: 'low', start: 0, end: 3 * STEP });
    expect(drop.explanation).toMatch(/fell 3\.2 °C in 1 h/);
    expect(drop.explanation).toMatch(/cannot confirm a cause/);
    expect(drop.explanation).not.toMatch(/broken|faulty|defect/i);
  });

  it('flags sustained deviation from the setpoint, but not in frost-protection mode', () => {
    const below = series([...repeat(8, [17, 20]), [20, 20]]);
    const res = detectAnomalies(below, STEP);
    expect(res.map((a) => a.type)).toEqual(['sustained_below_setpoint']);
    expect(res[0]!.explanation).toMatch(/for 4 h/);
    expect(res[0]!.evidence.length).toBeLessThanOrEqual(5);

    expect(types(series(repeat(20, [12, 7])))).toEqual([]); // hg/away setpoint
    expect(types(series(repeat(13, [24, 20])))).toEqual(['sustained_above_setpoint']);
    expect(types(series(repeat(11, [24, 20])))).toEqual([]); // < 6 h
  });

  it('flags long constant readings only when the setpoint changed meanwhile', () => {
    const stuck = series([...repeat(12, [19.2, 19]), ...repeat(13, [19.2, 20.2])]);
    expect(types(stuck)).toContain('flatline');
    expect(types(series(repeat(30, [19.2, 19])))).toEqual([]);
  });

  it('reports long gaps as missing data', () => {
    const gaps = [
      { after: 0, before: 10 * STEP, missingPoints: 9 },
      { after: 0, before: 3 * STEP, missingPoints: 2 },
    ];
    const res = detectAnomalies(series([[20, 20]]), STEP, gaps);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ type: 'missing_data', severity: 'low', confidence: 'high' });
    expect(res[0]!.explanation).toMatch(/about 4\.5 h/);
  });

  it('orders findings by severity, then time', () => {
    const res = detectAnomalies(series([...repeat(8, [17, 20]), [50, 20]]), STEP);
    expect(res.map((a) => a.severity)).toEqual(['high', 'high', 'medium']);
  });
});
