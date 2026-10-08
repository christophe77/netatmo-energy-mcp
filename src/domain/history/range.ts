/** Range and scale resolution shared by history and analytics. */
import { InvalidArgumentError } from '../../errors.js';
import { LARGE_SCALES, SCALE_SECONDS, type Scale } from '../../netatmo/endpoints.js';
import { parseIsoInZone, resolvePeriod, tzOffsetSeconds, type Period } from '../../utils/dates.js';
import { DEFAULT_MAX_REQUESTS, estimateRequests } from './history-service.js';

export const MAX_RANGE_DAYS = 400;

export interface RangeInput {
  period?: Period | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export interface Range {
  begin: number;
  end: number;
}

/** Resolve a named period or ISO from/to in the home time zone; `end` is clamped to now. */
export function resolveRange(
  input: RangeInput,
  fallback: Period,
  tz: string,
  now: number,
  maxDays = MAX_RANGE_DAYS,
): Range {
  if (input.period && (input.from || input.to)) {
    throw new InvalidArgumentError('Use either "period" or "from"/"to", not both.');
  }
  let begin: number;
  let end: number;
  if (input.from) {
    begin = parseIsoInZone(input.from, tz);
    end = input.to ? parseIsoInZone(input.to, tz) : now;
  } else if (input.to) {
    throw new InvalidArgumentError('"to" requires "from".');
  } else {
    ({ begin, end } = resolvePeriod(input.period ?? fallback, now, tz));
  }
  end = Math.min(end, now);
  if (begin >= end) {
    throw new InvalidArgumentError(
      'The start of the range must be before its end (and in the past).',
    );
  }
  if (end - begin > maxDays * 86_400) {
    throw new InvalidArgumentError(`This range is limited to ${maxDays} days.`);
  }
  return { begin, end };
}

const ROOM_AUTO_SCALES: Scale[] = ['30min', '1hour', '3hours', '1day', '1week'];

/**
 * Explicit scale (checked against the per-query request cap) or the finest scale that
 * fits the range in a single request.
 */
export function chooseRoomScale(
  range: Range,
  requested: 'auto' | Scale | undefined,
  notes: string[],
): Scale {
  if (requested && requested !== 'auto') {
    const needed = estimateRequests(range, requested);
    if (needed > DEFAULT_MAX_REQUESTS) {
      throw new InvalidArgumentError(
        `The ${requested} scale would need about ${needed} Netatmo requests for this range (limit ${DEFAULT_MAX_REQUESTS}).`,
        { hint: 'Use scale "auto", a coarser scale or a shorter range.' },
      );
    }
    return requested;
  }
  const span = range.end - range.begin;
  const chosen = ROOM_AUTO_SCALES.find((s) => span / SCALE_SECONDS[s] + 1 <= 1024) ?? '1week';
  notes.push(`Scale "${chosen}" was chosen automatically for this range.`);
  return chosen;
}

/**
 * Sub-daily buckets start exactly at date_begin (observed), so align the start to the scale
 * in local time to get readable bucket boundaries. Daily and longer scales are aligned by
 * Netatmo to local midnight.
 */
export function alignBegin(begin: number, scale: Scale, tz: string): number {
  if (LARGE_SCALES.includes(scale)) return begin;
  const step = SCALE_SECONDS[scale];
  const off = tzOffsetSeconds(begin, tz);
  return Math.floor((begin + off) / step) * step - off;
}

export function expectedPoints(begin: number, end: number, scale: Scale): number {
  return Math.max(0, Math.floor((end - begin) / SCALE_SECONDS[scale]) + 1);
}
