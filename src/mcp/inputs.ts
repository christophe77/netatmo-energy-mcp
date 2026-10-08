/** Input fields shared by several tools. */
import * as z from 'zod';
import { MAX_OUTPUT_POINTS } from '../domain/energy-service.js';
import { historyModeSchema } from '../domain/views.js';
import { SCALES } from '../netatmo/endpoints.js';
import { PERIODS } from '../utils/dates.js';

export const homeId = z
  .string()
  .min(1)
  .optional()
  .describe('Home ID from netatmo_list_homes. Optional when the account has a single home.');

export const roomId = z.string().min(1).optional().describe('Room ID from netatmo_list_rooms.');

export const roomName = z
  .string()
  .min(1)
  .optional()
  .describe('Room name (case- and accent-insensitive). Use room_id or room_name.');

export const period = z
  .enum(PERIODS)
  .optional()
  .describe('Named period in the home time zone. Alternative to from/to.');

export const from = z
  .string()
  .optional()
  .describe(
    'Range start, ISO 8601 (e.g. 2026-01-15 or 2026-01-15T07:30). Without an offset it is read in the home time zone.',
  );

export const to = z
  .string()
  .optional()
  .describe('Range end, ISO 8601. Defaults to now when "from" is given.');

export const mode = historyModeSchema
  .optional()
  .describe(
    'summary = statistics only; aggregated (default) = statistics + up to max_points buckets; detailed = raw values (bounded).',
  );

export const maxPoints = z
  .number()
  .int()
  .min(1)
  .max(MAX_OUTPUT_POINTS)
  .optional()
  .describe('Maximum buckets/points returned (default 48 aggregated, 200 detailed).');

export const roomScale = z
  .enum(['auto', ...SCALES])
  .optional()
  .describe('Measurement resolution. "auto" (default) picks the finest scale that fits the range.');

export const boilerScale = z
  .enum(['auto', '1hour', '3hours', '1day', '1week', '1month'])
  .optional()
  .describe('Resolution. "auto" (default): 1hour up to 2 days, 1day up to 93 days, else 1week.');
