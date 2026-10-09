import type { McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { ConfirmMode } from '../domain/write-limits.js';
import type { ControlService } from '../domain/control-service.js';
import { DAYS } from '../domain/heating/schedule.js';
import { homeRefSchema } from '../domain/views.js';
import type { Logger } from '../utils/logger.js';
import {
  confirmAndApply,
  ConfirmationTokens,
  type ConfirmationStore,
  type ConfirmContext,
} from './confirm.js';
import * as input from './inputs.js';
import { runTool } from './results.js';

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const CONFIRMATION_NOTE =
  ' Changes the real heating. The user must confirm: either the client asks them directly, or the first call returns a preview and a confirmation_token; call again with the token only after the user explicitly agreed.';

const confirmationToken = z
  .string()
  .max(100)
  .optional()
  .describe('Token from the preview, only after the user explicitly confirmed the change.');

const scheduleRef = {
  schedule_id: z
    .string()
    .min(1)
    .max(input.MAX_ID_LENGTH)
    .optional()
    .describe('Schedule ID from netatmo_get_schedules.'),
  schedule_name: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Schedule name (case/accent-insensitive).'),
};

const schedulePatch = {
  away_temperature: z.number().optional().describe('Away-mode temperature (°C).'),
  frost_guard_temperature: z.number().optional().describe('Frost-guard temperature (°C).'),
  zone_temperatures: z
    .array(
      z.object({
        zone: z
          .string()
          .min(1)
          .max(64)
          .describe('Zone name or ID, e.g. "Comfort", "Night", "Eco".'),
        room: z.string().min(1).max(input.MAX_ID_LENGTH).describe('Room name or ID.'),
        temperature: z.number().describe('Setpoint (°C) for this room while the zone applies.'),
      }),
    )
    .max(200)
    .optional()
    .describe('Room setpoints to change inside zones.'),
  timetable: z
    .array(
      z.object({
        day: z.enum(DAYS),
        time: z
          .string()
          .regex(/^\d{1,2}:\d{2}$/)
          .describe('Start time HH:MM (24 h).'),
        zone: z.string().min(1).max(64).describe('Zone name or ID applied from this time.'),
      }),
    )
    .max(500)
    .optional()
    .describe(
      'Full replacement of the weekly timetable. Each entry applies its zone until the next entry; the first must be monday 00:00. Omit to keep the current timetable.',
    ),
};

function annotations(destructive: boolean, idempotent: boolean): ToolAnnotations {
  return {
    readOnlyHint: false,
    destructiveHint: destructive,
    idempotentHint: idempotent,
    openWorldHint: true,
  };
}

/** Read-only schedule inspection, available in every mode. */
export function registerScheduleReadTool(
  server: McpServer,
  control: ControlService,
  logger: Logger,
): void {
  server.registerTool(
    'netatmo_get_schedules',
    {
      title: 'Get heating schedules',
      description:
        'Weekly heating schedules of a home: zones (e.g. Comfort, Night, Eco) with the setpoint of each room, away/frost-guard temperatures, and the timetable as day + time + zone. Shows which schedule is active.',
      inputSchema: z.object({ home_id: input.homeId }),
      outputSchema: z.object({
        home: homeRefSchema,
        schedules: z.array(
          z.object({
            id: z.string(),
            name: z.string().nullable(),
            active: z.boolean(),
            away_temperature_c: z.number().nullable(),
            frost_guard_temperature_c: z.number().nullable(),
            zones: z.array(
              z.object({
                id: z.number(),
                name: z.string().nullable(),
                type: z.number().nullable(),
                rooms: z.array(
                  z.object({
                    room_id: z.string(),
                    room_name: z.string(),
                    temperature_c: z.number().nullable(),
                  }),
                ),
              }),
            ),
            timetable: z.array(z.object({ day: z.enum(DAYS), time: z.string(), zone: z.string() })),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    ({ home_id }, ctx) =>
      runTool(logger, () => control.getSchedules(home_id, { signal: ctx.mcpReq.signal })),
  );
}

/** Heating control tools: registered only in opt-in write mode (ADR-0012). */
export function registerWriteTools(
  server: McpServer,
  control: ControlService,
  logger: Logger,
  options: {
    confirmMode?: ConfirmMode;
    /**
     * Where confirmation tokens live. Default: in memory, which suits one long-lived connection
     * (stdio). Per-request HTTP serving must pass a store shared across requests.
     */
    confirmations?: ConfirmationStore;
  } = {},
): void {
  const c: ConfirmContext = {
    server,
    tokens: options.confirmations ?? new ConfirmationTokens(() => control.now()),
    logger,
    mode: options.confirmMode ?? 'auto',
  };
  const signalOf = (ctx: { mcpReq: { signal: AbortSignal } }) => ({ signal: ctx.mcpReq.signal });

  server.registerTool(
    'netatmo_set_room_setpoint',
    {
      title: 'Set a room temperature',
      description:
        'Temporarily set a room\'s target temperature (mode "manual"), boost it (mode "max", 30 °C, only if allowed by the configured maximum), or return it to its schedule (mode "schedule"). Manual and max setpoints always end (default 3 h, configurable maximum) and the room then follows its schedule again.' +
        CONFIRMATION_NOTE,
      inputSchema: z.object({
        home_id: input.homeId,
        room_id: input.roomId,
        room_name: input.roomName,
        mode: z.enum(['manual', 'max', 'schedule']),
        temperature: z.number().optional().describe('Target °C, required for mode "manual".'),
        duration_minutes: z
          .number()
          .int()
          .min(5)
          .max(720 * 60)
          .optional()
          .describe(
            'How long the setpoint lasts (default 3 h; capped by the configured maximum, 24 h by default).',
          ),
        until: input.to.describe(
          'End time (ISO 8601, home time zone). Alternative to duration_minutes.',
        ),
        confirmation_token: confirmationToken,
      }),
      annotations: annotations(false, true),
    },
    (args, ctx) =>
      confirmAndApply(c, ctx, 'netatmo_set_room_setpoint', args, (at) =>
        control.planRoomSetpoint(args, signalOf(ctx), at),
      ),
  );

  server.registerTool(
    'netatmo_set_home_mode',
    {
      title: 'Set the home heating mode',
      description:
        'Switch the whole home to "schedule", "away" (reduced temperature) or "frost_guard" mode, optionally until a date (away/frost_guard). With mode "schedule", a schedule can be chosen (experimental, undocumented Netatmo parameter).' +
        CONFIRMATION_NOTE,
      inputSchema: z.object({
        home_id: input.homeId,
        mode: z.enum(['schedule', 'away', 'frost_guard']),
        until: input.to.describe('End of away/frost-guard mode (ISO 8601, home time zone).'),
        ...scheduleRef,
        confirmation_token: confirmationToken,
      }),
      annotations: annotations(false, true),
    },
    (args, ctx) =>
      confirmAndApply(c, ctx, 'netatmo_set_home_mode', args, () =>
        control.planHomeMode(args, signalOf(ctx)),
      ),
  );

  server.registerTool(
    'netatmo_switch_schedule',
    {
      title: 'Activate a heating schedule',
      description: 'Make another weekly schedule the active one.' + CONFIRMATION_NOTE,
      inputSchema: z.object({
        home_id: input.homeId,
        ...scheduleRef,
        confirmation_token: confirmationToken,
      }),
      annotations: annotations(false, true),
    },
    (args, ctx) =>
      confirmAndApply(c, ctx, 'netatmo_switch_schedule', args, () =>
        control.planSwitchSchedule(args, signalOf(ctx)),
      ),
  );

  server.registerTool(
    'netatmo_create_schedule',
    {
      title: 'Create a heating schedule',
      description:
        'Create a new weekly schedule as a copy of an existing one (the active schedule by default) with optional changes: room temperatures per zone, away/frost-guard temperatures, and a new timetable. The new schedule is not activated. Schedules can only be deleted in the Netatmo app.' +
        CONFIRMATION_NOTE,
      inputSchema: z.object({
        home_id: input.homeId,
        name: z.string().min(1).max(64).describe('Name of the new schedule.'),
        based_on_schedule_id: scheduleRef.schedule_id.describe(
          'Schedule to copy (default: active).',
        ),
        based_on_schedule_name: scheduleRef.schedule_name.describe('Schedule to copy, by name.'),
        ...schedulePatch,
        confirmation_token: confirmationToken,
      }),
      annotations: annotations(false, false),
    },
    (args, ctx) =>
      confirmAndApply(c, ctx, 'netatmo_create_schedule', args, () =>
        control.planCreateSchedule(args, signalOf(ctx)),
      ),
  );

  server.registerTool(
    'netatmo_update_schedule',
    {
      title: 'Modify a heating schedule',
      description:
        'Modify a weekly schedule (the active one by default): room temperatures per zone, away/frost-guard temperatures, and/or replace the whole timetable. Values not given are kept. Use netatmo_get_schedules first to see zones and the timetable.' +
        CONFIRMATION_NOTE,
      inputSchema: z.object({
        home_id: input.homeId,
        ...scheduleRef,
        ...schedulePatch,
        confirmation_token: confirmationToken,
      }),
      annotations: annotations(true, true),
    },
    (args, ctx) =>
      confirmAndApply(c, ctx, 'netatmo_update_schedule', args, () =>
        control.planUpdateSchedule(args, signalOf(ctx)),
      ),
  );

  server.registerTool(
    'netatmo_rename_schedule',
    {
      title: 'Rename a heating schedule',
      description:
        'Rename a weekly schedule (experimental: undocumented Netatmo endpoint).' +
        CONFIRMATION_NOTE,
      inputSchema: z.object({
        home_id: input.homeId,
        ...scheduleRef,
        new_name: z.string().min(1).max(64),
        confirmation_token: confirmationToken,
      }),
      annotations: annotations(false, true),
    },
    (args, ctx) =>
      confirmAndApply(c, ctx, 'netatmo_rename_schedule', args, () =>
        control.planRenameSchedule(args, signalOf(ctx)),
      ),
  );
}
