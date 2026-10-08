/**
 * The complete list of Netatmo endpoints this project can call.
 *
 * v0.1 is read-only by construction (ADR-0002): the client builds request URLs only from this
 * allow-list, and a unit test fails if a write endpoint is ever added here.
 */
export const API_BASE_URL = 'https://api.netatmo.com/api';

export const READ_ENDPOINTS = {
  homesdata: '/homesdata',
  homestatus: '/homestatus',
  getroommeasure: '/getroommeasure',
  getmeasure: '/getmeasure',
} as const;

export type ReadEndpoint = keyof typeof READ_ENDPOINTS;

/** Measurement scales accepted by the Energy getroommeasure/getmeasure endpoints. */
export const SCALES = ['30min', '1hour', '3hours', '1day', '1week', '1month'] as const;
export type Scale = (typeof SCALES)[number];

/** Nominal step length in seconds (a month is variable; 31 days is used as an upper bound). */
export const SCALE_SECONDS: Record<Scale, number> = {
  '30min': 1_800,
  '1hour': 3_600,
  '3hours': 10_800,
  '1day': 86_400,
  '1week': 604_800,
  '1month': 2_678_400,
};

export const LARGE_SCALES: readonly Scale[] = ['1day', '1week', '1month'];

export const ROOM_MEASURE_TYPES = [
  'temperature',
  'sp_temperature',
  'min_temp',
  'max_temp',
  'date_min_temp',
  'date_max_temp',
] as const;
export type RoomMeasureType = (typeof ROOM_MEASURE_TYPES)[number];

export const BOILER_MEASURE_TYPES = [
  'boileron',
  'boileroff',
  'sum_boiler_on',
  'sum_boiler_off',
] as const;
export type BoilerMeasureType = (typeof BOILER_MEASURE_TYPES)[number];

/** Maximum number of values per measure request (documented default and maximum). */
export const MAX_MEASURE_LIMIT = 1024;
