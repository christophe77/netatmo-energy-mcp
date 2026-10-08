import { McpServer } from '@modelcontextprotocol/server';
import type { AnalyticsService } from '../domain/analytics-service.js';
import type { EnergyService } from '../domain/energy-service.js';
import type { Logger } from '../utils/logger.js';
import { PACKAGE_NAME, VERSION } from '../version.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools.js';

export const SERVER_INSTRUCTIONS = `Read-only access to a Netatmo Energy heating system (smart thermostat, smart radiator valves, relay).
- Start with netatmo_list_homes or netatmo_list_rooms; rooms can be referenced by name.
- Current values: netatmo_get_home_status (all rooms), netatmo_get_room_status (one room), netatmo_get_heating_status (boiler and demand), netatmo_get_device_status (batteries, signal).
- History: netatmo_get_temperature_history, netatmo_get_setpoint_history, netatmo_get_boiler_history. Prefer mode "summary" or "aggregated"; use "detailed" only for short ranges.
- Analytics: netatmo_get_heating_summary (period overview), netatmo_compare_rooms (rankings), netatmo_detect_anomalies (rule-based findings with severity and confidence).
- Temperatures are in °C; times are ISO 8601 in the home's time zone.
- Boiler "heat demand" time is when the thermostat requested heat. It is not gas or energy consumption, which Netatmo does not measure.
- This server cannot change any setting.`;

/** Build the MCP server around the application service. Transport-agnostic. */
export function createMcpServer(
  service: EnergyService,
  analytics: AnalyticsService,
  logger: Logger,
): McpServer {
  const server = new McpServer(
    { name: PACKAGE_NAME, version: VERSION, title: 'Netatmo Energy' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, service, analytics, logger);
  registerResources(server, service);
  registerPrompts(server);
  return server;
}
