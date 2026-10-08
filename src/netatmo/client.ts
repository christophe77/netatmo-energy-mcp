import type { TokenProvider } from '../auth/token-manager.js';
import type { FetchFn } from '../auth/oauth.js';
import type { AppError } from '../errors.js';
import { InvalidArgumentError, InvalidResponseError, NetatmoUnavailableError } from '../errors.js';
import { systemClock, type Clock } from '../utils/clock.js';
import { silentLogger, type Logger } from '../utils/logger.js';
import { USER_AGENT } from '../version.js';
import {
  API_BASE_URL,
  BOILER_MEASURE_TYPES,
  LARGE_SCALES,
  MAX_MEASURE_LIMIT,
  READ_ENDPOINTS,
  SCALE_SECONDS,
  type BoilerMeasureType,
  type ReadEndpoint,
  type RoomMeasureType,
  type Scale,
} from './endpoints.js';
import { classifyApiError } from './errors.js';
import { decodeMeasureBody, type DecodedMeasures } from './measures.js';
import { RateLimiter } from './rate-limiter.js';
import {
  envelopeSchema,
  homesDataBodySchema,
  homeStatusBodySchema,
  type HomesDataBody,
  type HomeStatusBody,
} from './schemas.js';
import type * as z from 'zod';

export type QueryValue = string | number | boolean | readonly string[] | undefined;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface ApiResponse<T> {
  body: T;
  /** Netatmo server time (Unix s), when provided. */
  timeServer: number | undefined;
}

/** Raw exchange details, exposed for the `probe` command. Never contains the token. */
export interface RawExchange {
  endpoint: ReadEndpoint;
  query: Query;
  status: number;
  /** Lower-cased response header names and values related to rate limiting/retries. */
  rateHeaders: Record<string, string>;
  json: unknown;
}

export interface NetatmoClientOptions {
  tokens: TokenProvider;
  fetch?: FetchFn;
  clock?: Clock;
  logger?: Logger;
  rateLimiter?: RateLimiter;
  baseUrl?: string;
  timeoutMs?: number;
  /** Total attempts for retryable failures (network, 5xx, 429). */
  maxAttempts?: number;
  /** Source of randomness for backoff jitter (tests). */
  random?: () => number;
  cacheTtlMs?: { homesData?: number; homeStatus?: number };
  /** Observer for raw exchanges (used by `probe`). */
  onExchange?: (exchange: RawExchange) => void;
}

export interface RoomMeasureQuery {
  homeId: string;
  roomId: string;
  scale: Scale;
  types: readonly RoomMeasureType[];
  /** Unix seconds. */
  dateBegin?: number;
  /** Unix seconds. */
  dateEnd?: number;
  limit?: number;
  /** Default true here: timestamps mark the start of each bucket (ADR-0010). */
  realTime?: boolean;
  optimize?: boolean;
}

export interface ModuleMeasureQuery {
  /** Gateway (relay / OpenTherm gateway) ID. */
  deviceId: string;
  /** Thermostat module ID. */
  moduleId: string;
  scale: Scale;
  types: readonly BoilerMeasureType[];
  dateBegin?: number;
  dateEnd?: number;
  limit?: number;
  realTime?: boolean;
  optimize?: boolean;
}

export interface MeasureResult extends DecodedMeasures {
  types: readonly string[];
  scale: Scale;
}

interface CacheEntry {
  expires: number;
  value: Promise<unknown>;
}

/**
 * Typed, read-only Netatmo Energy API client. Independent of MCP.
 * Handles authentication, timeouts, cancellation, rate limiting, retries with backoff,
 * error classification and response validation.
 */
export class NetatmoClient {
  private readonly fetch: FetchFn;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly limiter: RateLimiter;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly random: () => number;
  private readonly ttl: { homesData: number; homeStatus: number };
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly opts: NetatmoClientOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.clock = opts.clock ?? systemClock;
    this.logger = opts.logger ?? silentLogger;
    this.limiter = opts.rateLimiter ?? new RateLimiter({ clock: this.clock });
    this.baseUrl = opts.baseUrl ?? API_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.random = opts.random ?? Math.random;
    this.ttl = {
      homesData: opts.cacheTtlMs?.homesData ?? 10 * 60_000,
      homeStatus: opts.cacheTtlMs?.homeStatus ?? 30_000,
    };
  }

  /** Topology: homes, rooms, modules and schedules. Cached for 10 minutes. */
  async homesData(
    params: { homeId?: string } = {},
    options: RequestOptions = {},
  ): Promise<ApiResponse<HomesDataBody>> {
    return this.cached(`homesdata:${params.homeId ?? '*'}`, this.ttl.homesData, () =>
      this.get('homesdata', { home_id: params.homeId }, homesDataBodySchema, options),
    );
  }

  /** Current state of rooms and modules. Cached for 30 seconds. */
  async homeStatus(
    homeId: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse<HomeStatusBody>> {
    return this.cached(`homestatus:${homeId}`, this.ttl.homeStatus, () =>
      this.get('homestatus', { home_id: homeId }, homeStatusBodySchema, options),
    );
  }

  /** One page (≤ 1024 values) of room temperature/setpoint history. */
  async getRoomMeasure(q: RoomMeasureQuery, options: RequestOptions = {}): Promise<MeasureResult> {
    validateRoomTypes(q.scale, q.types);
    const res = await this.get(
      'getroommeasure',
      {
        home_id: q.homeId,
        room_id: q.roomId,
        scale: q.scale,
        type: q.types,
        ...measureWindow(q),
      },
      undefined,
      options,
    );
    return {
      ...decodeMeasureBody(res.body, q.types.length, SCALE_SECONDS[q.scale]),
      types: q.types,
      scale: q.scale,
    };
  }

  /** One page (≤ 1024 values) of boiler activity history for a thermostat module. */
  async getMeasure(q: ModuleMeasureQuery, options: RequestOptions = {}): Promise<MeasureResult> {
    validateBoilerTypes(q.scale, q.types);
    const res = await this.get(
      'getmeasure',
      {
        device_id: q.deviceId,
        module_id: q.moduleId,
        scale: q.scale,
        type: q.types,
        ...measureWindow(q),
      },
      undefined,
      options,
    );
    return {
      ...decodeMeasureBody(res.body, q.types.length, SCALE_SECONDS[q.scale]),
      types: q.types,
      scale: q.scale,
    };
  }

  /** Drop cached topology/status (e.g. after the user renames a room). */
  clearCache(): void {
    this.cache.clear();
  }

  private cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const now = this.clock.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(key, { expires: now + ttlMs, value });
    // Never cache failures.
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    return value;
  }

  private async get<T = unknown>(
    endpoint: ReadEndpoint,
    query: Query,
    bodySchema: z.ZodType<T> | undefined,
    options: RequestOptions,
  ): Promise<ApiResponse<T>> {
    const json = await this.request(endpoint, query, options.signal);
    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success) {
      throw new InvalidResponseError(`Netatmo returned an unexpected envelope for ${endpoint}.`);
    }
    let body: unknown = envelope.data.body;
    if (bodySchema) {
      const parsed = bodySchema.safeParse(body);
      if (!parsed.success) {
        this.logger.debug('Response validation failed', {
          endpoint,
          issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
        });
        throw new InvalidResponseError(`Netatmo returned unexpected data for ${endpoint}.`);
      }
      body = parsed.data;
    }
    return {
      body: body as T,
      timeServer: envelope.data.time_server,
    };
  }

  /** Perform a GET on an allow-listed read endpoint with auth, retries and classification. */
  private async request(
    endpoint: ReadEndpoint,
    query: Query,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = buildUrl(this.baseUrl, READ_ENDPOINTS[endpoint], query);
    let tokenRefreshed = false;
    let lastError: AppError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts;) {
      signal?.throwIfAborted();
      await this.limiter.acquire(signal);
      const token = await this.opts.tokens.getAccessToken(signal);

      let res: Response;
      const timeout = AbortSignal.timeout(this.timeoutMs);
      try {
        res = await this.fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
          },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        const timedOut = timeout.aborted;
        lastError = new NetatmoUnavailableError(
          timedOut
            ? `Netatmo did not respond within ${this.timeoutMs / 1000} s (${endpoint}).`
            : `Could not reach the Netatmo API (${endpoint}).`,
          { cause: error },
        );
        if (attempt >= this.maxAttempts) throw lastError;
        await this.backoff(attempt, undefined, signal);
        attempt++;
        continue;
      }

      const text = await res.text();
      let json: unknown;
      try {
        json = text === '' ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      this.opts.onExchange?.({
        endpoint,
        query,
        status: res.status,
        rateHeaders: rateHeaders(res.headers),
        json,
      });

      if (res.ok && json !== undefined) return json;
      if (res.ok) {
        throw new InvalidResponseError(
          `Netatmo returned an empty or non-JSON response for ${endpoint}.`,
        );
      }

      const classified = classifyApiError(
        res.status,
        json,
        res.headers.get('retry-after'),
        this.clock.now(),
      );
      lastError = classified.error;
      this.logger.debug('Netatmo API error', {
        endpoint,
        status: res.status,
        code: classified.error.code,
        attempt,
      });

      if (classified.tokenRejected) {
        if (tokenRefreshed) throw classified.error;
        tokenRefreshed = true;
        await this.opts.tokens.handleRejectedToken(token, signal);
        continue; // does not count as an attempt
      }
      if (!classified.retryable || attempt >= this.maxAttempts) throw classified.error;
      await this.backoff(attempt, classified.retryAfterMs, signal);
      attempt++;
    }
    throw lastError ?? new NetatmoUnavailableError(`Request to ${endpoint} failed.`);
  }

  /** Exponential backoff with full jitter (base 500 ms, cap 8 s); honours Retry-After. */
  private async backoff(attempt: number, retryAfterMs: number | undefined, signal?: AbortSignal) {
    const exp = Math.min(8_000, 500 * 2 ** (attempt - 1));
    const delay = retryAfterMs ?? Math.round(this.random() * exp);
    await this.clock.sleep(delay, signal);
  }
}

function measureWindow(q: {
  dateBegin?: number;
  dateEnd?: number;
  limit?: number;
  realTime?: boolean;
  optimize?: boolean;
}): Query {
  const limit = q.limit ?? MAX_MEASURE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MEASURE_LIMIT) {
    throw new InvalidArgumentError(`limit must be an integer between 1 and ${MAX_MEASURE_LIMIT}.`);
  }
  if (q.dateBegin !== undefined && q.dateEnd !== undefined && q.dateEnd <= q.dateBegin) {
    throw new InvalidArgumentError('The end of the time range must be after its start.');
  }
  return {
    date_begin: q.dateBegin,
    date_end: q.dateEnd,
    limit,
    optimize: q.optimize ?? true,
    real_time: q.realTime ?? true,
  };
}

function validateRoomTypes(scale: Scale, types: readonly RoomMeasureType[]): void {
  if (types.length === 0) throw new InvalidArgumentError('At least one measure type is required.');
  if (!LARGE_SCALES.includes(scale) && types.some((t) => t.startsWith('date_'))) {
    throw new InvalidArgumentError(
      'date_min_temp and date_max_temp are only available for the 1day, 1week and 1month scales.',
    );
  }
}

function validateBoilerTypes(scale: Scale, types: readonly BoilerMeasureType[]): void {
  if (types.length === 0) throw new InvalidArgumentError('At least one measure type is required.');
  const large = LARGE_SCALES.includes(scale);
  for (const t of types) {
    if (!BOILER_MEASURE_TYPES.includes(t)) throw new InvalidArgumentError(`Unknown type ${t}.`);
    if (t.startsWith('sum_') !== large) {
      throw new InvalidArgumentError(
        large
          ? `${t} is only available for 30min, 1hour and 3hours; use sum_boiler_on/sum_boiler_off for ${scale}.`
          : `${t} is only available for 1day, 1week and 1month; use boileron/boileroff for ${scale}.`,
      );
    }
  }
}

export function buildUrl(baseUrl: string, path: string, query: Query): string {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  return url.toString();
}

function rateHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (/rate|limit|retry|quota/i.test(key)) out[key.toLowerCase()] = value;
  });
  return out;
}
