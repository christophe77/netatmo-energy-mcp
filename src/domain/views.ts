/**
 * Public, JSON-serialisable views returned by the application service.
 * They double as MCP tool output schemas, so their shape is part of the public interface:
 * snake_case keys, ISO 8601 times with the home's offset, °C, explicit nulls for
 * "not reported", and explicit caveats for derived values.
 */
import * as z from 'zod';

const iso = z.string().describe('ISO 8601 date-time with the home UTC offset');
const nullableNumber = z.number().nullable();

export const homeRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  timezone: z.string().describe('IANA time zone of the home'),
});

// ------------------------------------------------------------ discovery

export const roomViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().nullable(),
  device_ids: z.array(z.string()),
  device_types: z.array(z.string()),
});

export const deviceViewSchema = z.object({
  id: z.string(),
  type: z.string().describe('Netatmo module type, e.g. NATherm1, NRV, NAPlug'),
  model: z.string(),
  category: z.enum(['gateway', 'thermostat', 'valve', 'other']),
  name: z.string().nullable(),
  room_id: z.string().nullable(),
  room_name: z.string().nullable(),
  bridge_id: z.string().nullable().describe('Gateway this device communicates through'),
});

export const homeSummarySchema = homeRefSchema.extend({
  room_count: z.number(),
  device_count: z.number(),
  device_summary: z.string(),
  heating_mode: z.string().nullable().describe('schedule | away | hg (frost guard)'),
  boiler_history_available: z.boolean(),
});

export const homeDetailSchema = homeSummarySchema.extend({
  temperature_control_mode: z.string().nullable(),
  default_manual_duration_min: nullableNumber,
  schedules: z.array(
    z.object({ id: z.string(), name: z.string().nullable(), selected: z.boolean() }),
  ),
  rooms: z.array(roomViewSchema),
  devices: z.array(deviceViewSchema),
});

// --------------------------------------------------------------- status

export const roomStatusViewSchema = z.object({
  room_id: z.string(),
  room_name: z.string(),
  room_type: z.string().nullable(),
  temperature_c: nullableNumber.describe('Measured room temperature'),
  setpoint_c: nullableNumber.describe('Target temperature'),
  difference_to_setpoint_c: nullableNumber.describe('Derived: temperature_c - setpoint_c'),
  setpoint_mode: z.string().nullable().describe('schedule | manual | max | off | away | hg'),
  setpoint_end: iso.nullable().describe('When a manual setpoint ends, if reported'),
  heating_demand_percent: nullableNumber.describe(
    'Heat requested by the room valves (demand, not boiler power)',
  ),
  open_window: z.boolean().nullable(),
  anticipating: z.boolean().nullable(),
  reachable: z.boolean().nullable(),
});

export const deviceStatusViewSchema = deviceViewSchema.extend({
  reachable: z.boolean().nullable(),
  battery_state: z.string().nullable(),
  battery_level_mv: nullableNumber,
  rf_strength: nullableNumber.describe('Radio signal; lower is better (90 low … 60 full)'),
  rf_quality: z.enum(['low', 'medium', 'high', 'full']).nullable(),
  wifi_strength: nullableNumber.describe('Wi-Fi signal; lower is better (86 poor … 56 good)'),
  wifi_quality: z.enum(['poor', 'average', 'good']).nullable(),
  firmware_revision: z.string().nullable(),
  boiler_on: z.boolean().nullable().describe('Thermostats only: heat currently requested'),
  error_codes: z.array(z.number()).describe('Device errors reported by Netatmo (6 = unreachable)'),
});

export const homeStatusViewSchema = z.object({
  home: homeRefSchema,
  observed_at: iso,
  heating_mode: z.string().nullable(),
  boiler_on: z.boolean().nullable(),
  rooms: z.array(roomStatusViewSchema),
  alerts: z.array(z.string()).describe('Unreachable devices, low batteries, open windows'),
});

export const heatingStatusViewSchema = z.object({
  home: homeRefSchema,
  observed_at: iso,
  heating_mode: z.string().nullable(),
  boiler_on: z.boolean().nullable().describe('Whether the thermostat currently requests heat'),
  boiler_source: z.string().nullable().describe('Thermostat type reporting boiler status'),
  rooms_requesting_heat: z.number(),
  rooms: z.array(
    roomStatusViewSchema.pick({
      room_id: true,
      room_name: true,
      temperature_c: true,
      setpoint_c: true,
      heating_demand_percent: true,
      anticipating: true,
      open_window: true,
    }),
  ),
  caveats: z.array(z.string()),
});

// -------------------------------------------------------------- history

export const historyModeSchema = z.enum(['summary', 'aggregated', 'detailed']);

export const statsSchema = z.object({
  count: z.number(),
  min: z.number(),
  min_time: iso,
  max: z.number(),
  max_time: iso,
  mean: z.number(),
  stddev: z.number(),
  first: z.number(),
  last: z.number(),
});

export const coverageSchema = z.object({
  expected_points: z.number(),
  received_points: z.number(),
  gaps: z.array(z.object({ from: iso, to: iso, missing_points: z.number() })),
  gaps_truncated: z.boolean(),
});

const historyBase = {
  home: homeRefSchema,
  range: z.object({ from: iso, to: iso }),
  scale: z.string(),
  mode: historyModeSchema,
  coverage: coverageSchema,
  requests: z.number().describe('Netatmo API requests used'),
  notes: z.array(z.string()),
};

export const bucketSchema = z.object({
  from: iso,
  to: iso,
  min: z.number(),
  mean: z.number(),
  max: z.number(),
  count: z.number(),
});

export const temperatureHistorySchema = z.object({
  ...historyBase,
  room: z.object({ id: z.string(), name: z.string() }),
  measure: z.enum(['temperature', 'setpoint']),
  unit: z.literal('°C'),
  stats: statsSchema.nullable(),
  buckets: z.array(bucketSchema).optional().describe('aggregated mode'),
  points: z
    .array(z.object({ time: iso, value: z.number() }))
    .optional()
    .describe('detailed mode'),
  changes: z
    .array(z.object({ from: iso, to: iso, value: z.number() }))
    .optional()
    .describe('setpoint only: periods with a constant setpoint'),
  truncated: z.boolean(),
});

export const boilerHistorySchema = z.object({
  ...historyBase,
  thermostat_type: z.string(),
  total_heat_demand_minutes: z.number(),
  heat_demand_fraction: nullableNumber.describe('Share of the covered time with heat demand (0–1)'),
  buckets: z
    .array(z.object({ from: iso, to: iso, heat_demand_minutes: z.number(), fraction: z.number() }))
    .optional(),
  truncated: z.boolean(),
  caveats: z.array(z.string()),
});

export type HomeRef = z.infer<typeof homeRefSchema>;
export type RoomView = z.infer<typeof roomViewSchema>;
export type DeviceView = z.infer<typeof deviceViewSchema>;
export type HomeSummary = z.infer<typeof homeSummarySchema>;
export type HomeDetail = z.infer<typeof homeDetailSchema>;
export type RoomStatusView = z.infer<typeof roomStatusViewSchema>;
export type DeviceStatusView = z.infer<typeof deviceStatusViewSchema>;
export type HomeStatusView = z.infer<typeof homeStatusViewSchema>;
export type HeatingStatusView = z.infer<typeof heatingStatusViewSchema>;
export type HistoryMode = z.infer<typeof historyModeSchema>;
export type Stats = z.infer<typeof statsSchema>;
export type Coverage = z.infer<typeof coverageSchema>;
export type Bucket = z.infer<typeof bucketSchema>;
export type TemperatureHistory = z.infer<typeof temperatureHistorySchema>;
export type BoilerHistory = z.infer<typeof boilerHistorySchema>;
