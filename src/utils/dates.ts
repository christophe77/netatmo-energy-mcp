/**
 * Time-zone aware helpers built on Intl only (ADR-0006, ADR-0010).
 * All instants are Unix seconds unless stated otherwise.
 */
import { InvalidArgumentError } from '../errors.js';

const partsFormatter = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatter.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    partsFormatter.set(timeZone, f);
  }
  return f;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(unixSeconds: number, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(new Date(unixSeconds * 1000));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset of `timeZone` from UTC at the given instant, in seconds (e.g. +7200 for CEST). */
export function tzOffsetSeconds(unixSeconds: number, timeZone: string): number {
  const p = localParts(unixSeconds, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  return asUtc - Math.floor(unixSeconds);
}

/** Convert a local wall-clock time in `timeZone` to Unix seconds (DST-aware). */
export function localToUnix(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
  let t = guess - tzOffsetSeconds(guess, timeZone);
  t = guess - tzOffsetSeconds(t, timeZone);
  return t;
}

/** Unix seconds of local midnight starting the day that contains `unixSeconds`. */
export function startOfLocalDay(unixSeconds: number, timeZone: string): number {
  const p = localParts(unixSeconds, timeZone);
  return localToUnix(timeZone, p.year, p.month, p.day);
}

/** Add whole local days (DST-aware: a day may last 23 or 25 hours). */
export function addLocalDays(unixSeconds: number, days: number, timeZone: string): number {
  const p = localParts(unixSeconds, timeZone);
  return localToUnix(timeZone, p.year, p.month, p.day + days, p.hour, p.minute, p.second);
}

/** ISO 8601 with the zone's UTC offset at that instant, e.g. "2026-01-15T07:30:00+01:00". */
export function formatIso(unixSeconds: number, timeZone: string): string {
  const p = localParts(unixSeconds, timeZone);
  const off = tzOffsetSeconds(unixSeconds, timeZone);
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const sign = off >= 0 ? '+' : '-';
  const offH = Math.floor(Math.abs(off) / 3600);
  const offM = Math.floor((Math.abs(off) % 3600) / 60);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(offH)}:${pad(offM)}`;
}

/** Local wall-clock time "2026-01-15 07:30". */
export function formatLocal(unixSeconds: number, timeZone: string): string {
  return formatIso(unixSeconds, timeZone).slice(0, 16).replace('T', ' ');
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const ISO_LOCAL =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parse an ISO 8601 date or date-time. Without an offset it is read as local time in
 * `timeZone` (the home's zone); with "Z" or an offset it is used as is.
 */
export function parseIsoInZone(input: string, timeZone: string): number {
  const m = ISO_LOCAL.exec(input.trim());
  if (!m) {
    throw new InvalidArgumentError(
      `"${input}" is not an ISO 8601 date or date-time (e.g. 2026-01-15 or 2026-01-15T07:30).`,
    );
  }
  const [, y, mo, d, h, mi, s, zone] = m;
  if (zone) {
    const t = Date.parse(
      `${y}-${mo}-${d}T${h ?? '00'}:${mi ?? '00'}:${s ?? '00'}${zone === 'Z' ? 'Z' : zone.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')}`,
    );
    if (Number.isNaN(t)) throw new InvalidArgumentError(`Invalid date-time "${input}".`);
    return Math.floor(t / 1000);
  }
  const values = [y, mo, d, h ?? '0', mi ?? '0', s ?? '0'].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const [year, month, day, hour, minute, second] = values;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw new InvalidArgumentError(`Invalid date-time "${input}".`);
  }
  return localToUnix(timeZone, year, month, day, hour, minute, second);
}

export const PERIODS = ['today', 'yesterday', 'last_24h', 'last_7d', 'last_30d'] as const;
export type Period = (typeof PERIODS)[number];

/** Resolve a named period in the home's time zone. `end` never exceeds `now`. */
export function resolvePeriod(
  period: Period,
  now: number,
  timeZone: string,
): { begin: number; end: number } {
  switch (period) {
    case 'today':
      return { begin: startOfLocalDay(now, timeZone), end: now };
    case 'yesterday': {
      const today = startOfLocalDay(now, timeZone);
      return { begin: addLocalDays(today, -1, timeZone), end: today - 1 };
    }
    case 'last_24h':
      return { begin: now - 86_400, end: now };
    case 'last_7d':
      return { begin: now - 7 * 86_400, end: now };
    case 'last_30d':
      return { begin: now - 30 * 86_400, end: now };
  }
}
