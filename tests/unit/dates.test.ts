import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  formatIso,
  formatLocal,
  localToUnix,
  parseIsoInZone,
  resolvePeriod,
  startOfLocalDay,
  tzOffsetSeconds,
} from '../../src/utils/dates.js';

const PARIS = 'Europe/Paris';
const at = (iso: string) => Date.parse(iso) / 1000;

describe('time zone helpers', () => {
  it('computes offsets across DST', () => {
    expect(tzOffsetSeconds(at('2026-01-15T12:00:00Z'), PARIS)).toBe(3600);
    expect(tzOffsetSeconds(at('2026-07-15T12:00:00Z'), PARIS)).toBe(7200);
  });

  it('formats ISO 8601 with the local offset', () => {
    expect(formatIso(at('2026-01-15T06:30:00Z'), PARIS)).toBe('2026-01-15T07:30:00+01:00');
    expect(formatIso(at('2026-07-15T06:30:00Z'), PARIS)).toBe('2026-07-15T08:30:00+02:00');
    expect(formatIso(at('2026-07-15T06:30:00Z'), 'UTC')).toBe('2026-07-15T06:30:00+00:00');
    expect(formatLocal(at('2026-07-15T06:30:00Z'), PARIS)).toBe('2026-07-15 08:30');
  });

  it('converts local wall-clock times, including around DST changes', () => {
    expect(localToUnix(PARIS, 2026, 10, 8)).toBe(at('2026-10-07T22:00:00Z'));
    expect(localToUnix(PARIS, 2026, 3, 29, 12)).toBe(at('2026-03-29T10:00:00Z'));
  });

  it('finds local midnight and adds local days over 23 h and 25 h days', () => {
    const springNoon = at('2026-03-29T10:00:00Z'); // 23-hour day
    expect(startOfLocalDay(springNoon, PARIS)).toBe(at('2026-03-28T23:00:00Z'));
    const autumnMidnight = localToUnix(PARIS, 2026, 10, 25); // 25-hour day
    expect(addLocalDays(autumnMidnight, 1, PARIS) - autumnMidnight).toBe(25 * 3600);
  });

  it('parses ISO input in the home zone unless an offset is given', () => {
    expect(parseIsoInZone('2026-01-15T07:30', PARIS)).toBe(at('2026-01-15T06:30:00Z'));
    expect(parseIsoInZone('2026-01-15', PARIS)).toBe(at('2026-01-14T23:00:00Z'));
    expect(parseIsoInZone('2026-01-15T07:30:00Z', PARIS)).toBe(at('2026-01-15T07:30:00Z'));
    expect(parseIsoInZone('2026-01-15T07:30:00+05:00', PARIS)).toBe(at('2026-01-15T02:30:00Z'));
    expect(() => parseIsoInZone('yesterday', PARIS)).toThrow(/ISO 8601/);
    expect(() => parseIsoInZone('2026-13-01', PARIS)).toThrow(/Invalid/);
  });

  it('resolves named periods in the home zone', () => {
    const now = at('2026-10-08T07:40:00Z'); // 09:40 in Paris
    expect(resolvePeriod('today', now, PARIS)).toEqual({
      begin: at('2026-10-07T22:00:00Z'),
      end: now,
    });
    expect(resolvePeriod('yesterday', now, PARIS)).toEqual({
      begin: at('2026-10-06T22:00:00Z'),
      end: at('2026-10-07T22:00:00Z') - 1,
    });
    expect(resolvePeriod('last_7d', now, PARIS).begin).toBe(now - 7 * 86_400);
  });
});
