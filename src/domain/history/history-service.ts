import { InvalidArgumentError, UnsupportedCapabilityError } from '../../errors.js';
import type { NetatmoClient, RequestOptions } from '../../netatmo/client.js';
import {
  MAX_MEASURE_LIMIT,
  SCALE_SECONDS,
  type BoilerMeasureType,
  type RoomMeasureType,
  type Scale,
} from '../../netatmo/endpoints.js';
import { dedupeAndSort, findGaps, type Gap, type MeasurePoint } from '../../netatmo/measures.js';
import { describeHeatingSetup, type Home } from '../homes/topology.js';

/** Hard cap on API requests per history query (ADR-0007). */
export const DEFAULT_MAX_REQUESTS = 8;

export interface TimeRange {
  /** Unix seconds, inclusive. */
  begin: number;
  /** Unix seconds, inclusive. */
  end: number;
}

export interface Series {
  scale: Scale;
  stepSeconds: number;
  types: readonly string[];
  range: TimeRange;
  points: MeasurePoint[];
  gaps: Gap[];
  requests: number;
  warnings: string[];
}

/** Rough upper bound on the number of requests needed for a range at a scale. */
export function estimateRequests(range: TimeRange, scale: Scale): number {
  const expectedPoints = Math.ceil((range.end - range.begin) / SCALE_SECONDS[scale]) + 1;
  return Math.max(1, Math.ceil(expectedPoints / MAX_MEASURE_LIMIT));
}

/**
 * Fetch a complete series by paging forward from `range.begin`: each page returns up to
 * 1024 values; the next page starts one second after the last returned timestamp.
 * Stops when a page is not full, the range is covered, or progress stalls.
 */
export async function fetchPaged(
  range: TimeRange,
  scale: Scale,
  fetchPage: (
    begin: number,
    end: number,
  ) => Promise<{ points: MeasurePoint[]; warnings: string[] }>,
  maxRequests = DEFAULT_MAX_REQUESTS,
): Promise<{ points: MeasurePoint[]; requests: number; warnings: string[] }> {
  if (range.end <= range.begin) {
    throw new InvalidArgumentError('The end of the time range must be after its start.');
  }
  const estimate = estimateRequests(range, scale);
  if (estimate > maxRequests) {
    throw new InvalidArgumentError(
      `This range needs about ${estimate} Netatmo requests at the ${scale} scale (limit ${maxRequests}).`,
      { hint: 'Use a coarser scale or a shorter time range.' },
    );
  }
  const all: MeasurePoint[] = [];
  const warnings: string[] = [];
  let cursor = range.begin;
  let requests = 0;
  while (cursor <= range.end && requests < maxRequests) {
    const page = await fetchPage(cursor, range.end);
    requests += 1;
    warnings.push(...page.warnings);
    all.push(...page.points);
    const last = page.points[page.points.length - 1];
    if (page.points.length < MAX_MEASURE_LIMIT || !last) break;
    if (last.t < cursor) {
      warnings.push('Netatmo returned data outside the requested window; paging stopped.');
      break;
    }
    cursor = last.t + 1;
  }
  return {
    points: dedupeAndSort(all).filter((p) => p.t >= range.begin && p.t <= range.end),
    requests,
    warnings,
  };
}

export class HistoryService {
  constructor(private readonly client: NetatmoClient) {}

  async roomSeries(
    q: {
      homeId: string;
      roomId: string;
      scale: Scale;
      types: readonly RoomMeasureType[];
      range: TimeRange;
      maxRequests?: number;
    },
    options: RequestOptions = {},
  ): Promise<Series> {
    const res = await fetchPaged(
      q.range,
      q.scale,
      (begin, end) =>
        this.client.getRoomMeasure(
          {
            homeId: q.homeId,
            roomId: q.roomId,
            scale: q.scale,
            types: q.types,
            dateBegin: begin,
            dateEnd: end,
          },
          options,
        ),
      q.maxRequests,
    );
    return this.series(q.scale, q.types, q.range, res);
  }

  /** Boiler activity history. Requires a thermostat (NATherm1/OTM/…) in the home. */
  async boilerSeries(
    q: {
      home: Home;
      scale: Scale;
      types: readonly BoilerMeasureType[];
      range: TimeRange;
      maxRequests?: number;
    },
    options: RequestOptions = {},
  ): Promise<Series> {
    const source = describeHeatingSetup(q.home).boilerSource;
    if (!source) {
      throw new UnsupportedCapabilityError(
        'Boiler activity history requires a Netatmo thermostat; none was found in this home.',
        {
          hint: 'Homes with only radiator valves and a relay do not report boiler activity history.',
        },
      );
    }
    const res = await fetchPaged(
      q.range,
      q.scale,
      (begin, end) =>
        this.client.getMeasure(
          {
            deviceId: source.deviceId,
            moduleId: source.moduleId,
            scale: q.scale,
            types: q.types,
            dateBegin: begin,
            dateEnd: end,
          },
          options,
        ),
      q.maxRequests,
    );
    return this.series(q.scale, q.types, q.range, res);
  }

  private series(
    scale: Scale,
    types: readonly string[],
    range: TimeRange,
    res: { points: MeasurePoint[]; requests: number; warnings: string[] },
  ): Series {
    const stepSeconds = SCALE_SECONDS[scale];
    // Month buckets vary in length; gap detection would produce false positives.
    const gaps = scale === '1month' ? [] : findGaps(res.points, stepSeconds, range);
    return { scale, stepSeconds, types, range, ...res, gaps };
  }
}
