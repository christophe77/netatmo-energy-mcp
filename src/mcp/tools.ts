import type { CallToolResult, McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { AnalyticsService } from '../domain/analytics-service.js';
import type { EnergyService } from '../domain/energy-service.js';
import {
  anomalyReportSchema,
  boilerHistorySchema,
  heatingSummarySchema,
  roomComparisonSchema,
  deviceStatusViewSchema,
  deviceViewSchema,
  heatingStatusViewSchema,
  homeDetailSchema,
  homeRefSchema,
  homeStatusViewSchema,
  homeSummarySchema,
  roomStatusViewSchema,
  roomViewSchema,
  temperatureHistorySchema,
} from '../domain/views.js';
import type { Logger } from '../utils/logger.js';
import * as input from './inputs.js';
import { runTool } from './results.js';

/** Every v0.1 tool only reads data (ADR-0002). Annotations are hints, not a safety mechanism. */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const historyInput = {
  home_id: input.homeId,
  room_id: input.roomId,
  room_name: input.roomName,
  period: input.period,
  from: input.from,
  to: input.to,
  scale: input.roomScale,
  mode: input.mode,
  max_points: input.maxPoints,
};

export function registerTools(
  server: McpServer,
  service: EnergyService,
  analytics: AnalyticsService,
  logger: Logger,
): void {
  const run = (fn: () => Promise<object>) => runTool(logger, fn);
  registerAnalyticsTools(server, analytics, run);

  // ---------------------------------------------------------------- discovery

  server.registerTool(
    'netatmo_list_homes',
    {
      title: 'List Netatmo homes',
      description:
        'List the homes in the Netatmo account that have Energy devices (thermostats, radiator valves), with room and device counts and whether boiler history is available.',
      outputSchema: z.object({ homes: z.array(homeSummarySchema) }),
      annotations: READ_ONLY,
    },
    (ctx) => run(() => service.listHomes({ signal: ctx.mcpReq.signal })),
  );

  server.registerTool(
    'netatmo_get_home',
    {
      title: 'Get Netatmo home details',
      description:
        'Details of one home: heating mode, schedules, rooms and devices (topology only; use the status tools for live values).',
      inputSchema: z.object({ home_id: input.homeId }),
      outputSchema: homeDetailSchema,
      annotations: READ_ONLY,
    },
    ({ home_id }, ctx) => run(() => service.getHome(home_id, { signal: ctx.mcpReq.signal })),
  );

  server.registerTool(
    'netatmo_list_rooms',
    {
      title: 'List rooms',
      description:
        'List the rooms of a home with their IDs, types and the devices installed in each.',
      inputSchema: z.object({ home_id: input.homeId }),
      outputSchema: z.object({ home: homeRefSchema, rooms: z.array(roomViewSchema) }),
      annotations: READ_ONLY,
    },
    ({ home_id }, ctx) => run(() => service.listRooms(home_id, { signal: ctx.mcpReq.signal })),
  );

  server.registerTool(
    'netatmo_list_devices',
    {
      title: 'List devices',
      description:
        'List thermostats, radiator valves and relays/gateways of a home with their model, room and gateway. Use netatmo_get_device_status for battery, signal and reachability.',
      inputSchema: z.object({ home_id: input.homeId }),
      outputSchema: z.object({ home: homeRefSchema, devices: z.array(deviceViewSchema) }),
      annotations: READ_ONLY,
    },
    ({ home_id }, ctx) => run(() => service.listDevices(home_id, { signal: ctx.mcpReq.signal })),
  );

  // ------------------------------------------------------------------- status

  server.registerTool(
    'netatmo_get_home_status',
    {
      title: 'Get current heating status of a home',
      description:
        'Current temperature, setpoint, mode and heating demand of every room, boiler on/off, and alerts (unreachable devices, low batteries, open windows).',
      inputSchema: z.object({ home_id: input.homeId }),
      outputSchema: homeStatusViewSchema,
      annotations: READ_ONLY,
    },
    ({ home_id }, ctx) => run(() => service.homeStatus(home_id, { signal: ctx.mcpReq.signal })),
  );

  server.registerTool(
    'netatmo_get_room_status',
    {
      title: 'Get current room temperature and setpoint',
      description:
        'Current measured temperature and target temperature (setpoint) of one room, with setpoint mode, heating demand and open-window state. Identify the room by room_id or room_name.',
      inputSchema: z.object({
        home_id: input.homeId,
        room_id: input.roomId,
        room_name: input.roomName,
      }),
      outputSchema: z.object({
        home: homeRefSchema,
        observed_at: z.string(),
        room: roomStatusViewSchema,
      }),
      annotations: READ_ONLY,
    },
    ({ home_id, room_id, room_name }, ctx) =>
      run(() => service.roomStatus(home_id, { room_id, room_name }, { signal: ctx.mcpReq.signal })),
  );

  server.registerTool(
    'netatmo_get_heating_status',
    {
      title: 'Get heating activity',
      description:
        'Whether the boiler is currently requested to heat, which rooms request heat (heating demand %), and anticipation. Demand is not boiler power or energy use.',
      inputSchema: z.object({ home_id: input.homeId }),
      outputSchema: heatingStatusViewSchema,
      annotations: READ_ONLY,
    },
    ({ home_id }, ctx) => run(() => service.heatingStatus(home_id, { signal: ctx.mcpReq.signal })),
  );

  server.registerTool(
    'netatmo_get_device_status',
    {
      title: 'Get device diagnostics',
      description:
        'Battery, radio/Wi-Fi signal, reachability, firmware and error codes of all devices of a home, or of one device.',
      inputSchema: z.object({
        home_id: input.homeId,
        device_id: z
          .string()
          .min(1)
          .max(input.MAX_ID_LENGTH)
          .optional()
          .describe('Device ID from netatmo_list_devices. Omit for all devices.'),
      }),
      outputSchema: z.object({
        home: homeRefSchema,
        observed_at: z.string(),
        devices: z.array(deviceStatusViewSchema),
      }),
      annotations: READ_ONLY,
    },
    ({ home_id, device_id }, ctx) =>
      run(() => service.deviceStatus(home_id, device_id, { signal: ctx.mcpReq.signal })),
  );

  // ------------------------------------------------------------------ history

  server.registerTool(
    'netatmo_get_temperature_history',
    {
      title: 'Get room temperature history',
      description:
        'Measured temperature history of a room with statistics (min, max, mean, variability) and coverage/gaps. Default: last 24 h, aggregated. Missing data is reported, never filled in.',
      inputSchema: z.object(historyInput),
      outputSchema: temperatureHistorySchema,
      annotations: READ_ONLY,
    },
    (args, ctx) =>
      run(() => service.temperatureHistory(args, 'temperature', { signal: ctx.mcpReq.signal })),
  );

  server.registerTool(
    'netatmo_get_setpoint_history',
    {
      title: 'Get room setpoint history',
      description:
        'Target temperature (setpoint) history of a room, including the periods during which each setpoint applied. Default: last 24 h.',
      inputSchema: z.object(historyInput),
      outputSchema: temperatureHistorySchema,
      annotations: READ_ONLY,
    },
    (args, ctx) =>
      run(() => service.temperatureHistory(args, 'setpoint', { signal: ctx.mcpReq.signal })),
  );

  server.registerTool(
    'netatmo_get_boiler_history',
    {
      title: 'Get boiler activity history',
      description:
        'How long the thermostat requested heat from the boiler over a period (minutes and share of time), per bucket. Requires a Netatmo thermostat. This is heat-demand time, not gas or energy consumption. Default: yesterday.',
      inputSchema: z.object({
        home_id: input.homeId,
        period: input.period,
        from: input.from,
        to: input.to,
        scale: input.boilerScale,
        mode: input.mode,
        max_points: input.maxPoints,
      }),
      outputSchema: boilerHistorySchema,
      annotations: READ_ONLY,
    },
    (args, ctx) => run(() => service.boilerHistory(args, { signal: ctx.mcpReq.signal })),
  );
}

function registerAnalyticsTools(
  server: McpServer,
  analytics: AnalyticsService,
  run: (fn: () => Promise<object>) => Promise<CallToolResult>,
): void {
  const range = { period: input.period, from: input.from, to: input.to };

  server.registerTool(
    'netatmo_get_heating_summary',
    {
      title: 'Summarise heating over a period',
      description:
        'Per-room temperature statistics, mean setpoint, time below / within / above target, largest temperature drop and cool-down rate, plus total boiler heat-demand time. Default: yesterday. Deterministic calculations; no energy or gas figures.',
      inputSchema: z.object({
        home_id: input.homeId,
        room_id: input.roomId,
        room_name: input.roomName.describe('Limit to one room (default: all rooms)'),
        ...range,
      }),
      outputSchema: heatingSummarySchema,
      annotations: READ_ONLY,
    },
    (args, ctx) => run(() => analytics.heatingSummary(args, { signal: ctx.mcpReq.signal })),
  );

  server.registerTool(
    'netatmo_compare_rooms',
    {
      title: 'Compare rooms',
      description:
        'Compare all rooms over a period (default: last 7 days): warmest/coolest, most variable, most time below target, largest drop and fastest cool-down after setpoint decreases. Returns per-room metrics and rankings.',
      inputSchema: z.object({ home_id: input.homeId, ...range }),
      outputSchema: roomComparisonSchema,
      annotations: READ_ONLY,
    },
    (args, ctx) => run(() => analytics.compareRooms(args, { signal: ctx.mcpReq.signal })),
  );

  server.registerTool(
    'netatmo_detect_anomalies',
    {
      title: 'Detect unusual heating behaviour',
      description:
        'Rule-based detection of unusual readings in 30-minute room data (default: last 24 h, at most 14 days): implausible values or jumps, constant readings, missing data, rapid drops at a constant setpoint, sustained deviation from the setpoint. Each finding has severity, confidence, evidence and an explanation; findings are observations, not diagnoses.',
      inputSchema: z.object({
        home_id: input.homeId,
        room_id: input.roomId,
        room_name: input.roomName.describe('Limit to one room (default: all rooms)'),
        ...range,
        max_anomalies: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum findings returned, most severe first (default 30)'),
      }),
      outputSchema: anomalyReportSchema,
      annotations: READ_ONLY,
    },
    (args, ctx) => run(() => analytics.detectAnomalies(args, { signal: ctx.mcpReq.signal })),
  );
}
