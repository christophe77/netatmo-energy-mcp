import { McpServer } from '@modelcontextprotocol/server';
import type { ConfirmMode } from '../domain/write-limits.js';
import type { AnalyticsService } from '../domain/analytics-service.js';
import type { ControlService } from '../domain/control-service.js';
import type { EnergyService } from '../domain/energy-service.js';
import type { Logger } from '../utils/logger.js';
import { PACKAGE_NAME, VERSION } from '../version.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools.js';
import { registerScheduleReadTool, registerWriteTools } from './write-tools.js';

const COMMON_INSTRUCTIONS = `Access to a Netatmo Energy heating system (smart thermostat, smart radiator valves, relay).
- Start with netatmo_list_homes or netatmo_list_rooms; rooms can be referenced by name.
- Current values: netatmo_get_home_status (all rooms), netatmo_get_room_status (one room), netatmo_get_heating_status (boiler and demand), netatmo_get_device_status (batteries, signal).
- Schedules: netatmo_get_schedules (zones, room setpoints, weekly timetable).
- History: netatmo_get_temperature_history, netatmo_get_setpoint_history, netatmo_get_boiler_history. Prefer mode "summary" or "aggregated"; use "detailed" only for short ranges.
- Analytics: netatmo_get_heating_summary (period overview), netatmo_compare_rooms (rankings), netatmo_detect_anomalies (rule-based findings with severity and confidence).
- Temperatures are in °C; times are ISO 8601 in the home's time zone.
- Boiler "heat demand" time is when the thermostat requested heat. It is not gas or energy consumption, which Netatmo does not measure.`;

const READ_ONLY_INSTRUCTIONS = `${COMMON_INSTRUCTIONS}
- This server is read-only: it cannot change any setting.`;

const WRITE_INSTRUCTIONS = `${COMMON_INSTRUCTIONS}
- Write mode is enabled: netatmo_set_room_setpoint, netatmo_set_home_mode, netatmo_switch_schedule, netatmo_create_schedule, netatmo_update_schedule, netatmo_rename_schedule change the real heating.
- Only change the heating when the user asks for it. Every change needs the user's explicit confirmation: never call a write tool with a confirmation_token unless the user has seen the preview and agreed.`;

export interface McpServerOptions {
  control: ControlService;
  /** Register heating control tools (opt-in write mode, ADR-0012). */
  writeMode: boolean;
  /** How changes are confirmed (NETATMO_MCP_CONFIRM). */
  confirmMode?: ConfirmMode;
}

/** Build the MCP server around the application services. Transport-agnostic. */
export function createMcpServer(
  service: EnergyService,
  analytics: AnalyticsService,
  logger: Logger,
  options: McpServerOptions,
): McpServer {
  const server = new McpServer(
    { name: PACKAGE_NAME, version: VERSION, title: 'Netatmo Energy' },
    { instructions: options.writeMode ? WRITE_INSTRUCTIONS : READ_ONLY_INSTRUCTIONS },
  );
  registerTools(server, service, analytics, logger);
  registerScheduleReadTool(server, options.control, logger);
  if (options.writeMode) {
    registerWriteTools(server, options.control, logger, {
      confirmMode: options.confirmMode ?? 'auto',
    });
  }
  registerResources(server, service);
  registerPrompts(server);
  return server;
}
