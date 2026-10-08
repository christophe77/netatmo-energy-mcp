/**
 * Runtime schemas for Netatmo Energy responses.
 *
 * Deliberately lenient (see docs/api-capabilities.md): unknown fields pass through, most fields
 * are optional/nullable, IDs may arrive as numbers, and known spelling variants from the
 * official spec are accepted alongside the spellings used by maintained libraries.
 * Only fields that this project relies on are declared.
 */
import * as z from 'zod';

/** IDs are documented as strings but the spec types room IDs as int64. Normalise to string. */
const id = z.union([z.string(), z.number()]).transform(String);
const num = z.number().nullish();
const str = z.string().nullish();
const bool = z.boolean().nullish();

export const envelopeSchema = z.looseObject({
  status: z.string().optional(),
  body: z.unknown(),
  time_server: z.number().optional(),
  time_exec: z.number().optional(),
});

// ---------------------------------------------------------------- homesdata

export const roomSchema = z.looseObject({
  id,
  name: str,
  type: str,
  module_ids: z.array(id).nullish(),
});

export const moduleSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  name: str,
  setup_date: num,
  room_id: id.nullish(),
  bridge: str,
  modules_bridged: z.array(z.string()).nullish(),
  /** Spelling used in the OpenAPI spec. */
  module_bridged: z.array(z.string()).nullish(),
});

export const scheduleSchema = z.looseObject({
  id: id,
  name: str,
  type: str,
  default: bool,
  selected: bool,
  away_temp: num,
  hg_temp: num,
});

export const homeSchema = z.looseObject({
  id: z.string(),
  name: str,
  timezone: str,
  country: str,
  therm_mode: str,
  temperature_control_mode: str,
  therm_setpoint_default_duration: num,
  /** Spelling used in the OpenAPI spec. */
  therm_set_point_default_duration: num,
  rooms: z.array(roomSchema).nullish(),
  modules: z.array(moduleSchema).nullish(),
  schedules: z.array(scheduleSchema).nullish(),
});

export const homesDataBodySchema = z.looseObject({
  homes: z.array(homeSchema).nullish(),
});

export type RawHome = z.infer<typeof homeSchema>;
export type HomesDataBody = z.infer<typeof homesDataBodySchema>;

// --------------------------------------------------------------- homestatus

export const roomStatusSchema = z.looseObject({
  id,
  reachable: bool,
  therm_measured_temperature: num,
  therm_setpoint_temperature: num,
  therm_setpoint_mode: str,
  therm_setpoint_start_time: num,
  therm_setpoint_end_time: num,
  heating_power_request: num,
  anticipating: bool,
  open_window: bool,
  /** Spelling used in the OpenAPI spec. */
  open_windows: bool,
});

export const moduleStatusSchema = z.looseObject({
  id: z.string(),
  type: str,
  reachable: bool,
  bridge: str,
  firmware_revision: z.union([z.number(), z.string()]).nullish(),
  rf_strength: num,
  rf_strenght: num,
  wifi_strength: num,
  wifi_strenght: num,
  battery_state: str,
  battery_level: num,
  boiler_status: bool,
  boiler_valve_comfort_boost: bool,
  anticipating: bool,
  boiler_control: str,
  dhw_control: str,
  boiler_error: z.unknown().optional(),
});

export const homeStatusBodySchema = z.looseObject({
  home: z.looseObject({
    id: z.string(),
    rooms: z.array(roomStatusSchema).nullish(),
    modules: z.array(moduleStatusSchema).nullish(),
  }),
  errors: z.array(z.looseObject({ id: z.string().nullish(), code: z.number() })).nullish(),
});

export type HomeStatusBody = z.infer<typeof homeStatusBodySchema>;
export type RawRoomStatus = z.infer<typeof roomStatusSchema>;
export type RawModuleStatus = z.infer<typeof moduleStatusSchema>;

// ----------------------------------------------------------------- measures

const measureValue = z.number().nullable();

/** optimize=true: segments that restart after each data gap. */
export const measureSegmentsSchema = z.array(
  z.looseObject({
    beg_time: z.number(),
    step_time: z.number().nullish(),
    value: z.array(z.array(measureValue)),
  }),
);

/** optimize=false: { "<unix seconds>": [v1, v2, …] }. */
export const measureMapSchema = z.record(z.string(), z.array(measureValue));
