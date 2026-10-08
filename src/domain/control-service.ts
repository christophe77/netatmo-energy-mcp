/**
 * Heating control (opt-in write mode, ADR-0012).
 *
 * Every operation is split in two: `plan*()` validates the request, applies the configured
 * limits and describes the change (before → after) without touching anything; the returned
 * plan's `apply()` performs the single Netatmo write and records it in the local change log.
 * The MCP layer only calls `apply()` after the user has confirmed.
 */
import type { WriteLimits } from '../config/loader.js';
import { InvalidArgumentError } from '../errors.js';
import type { NetatmoClient } from '../netatmo/client.js';
import type { WriteEndpoint } from '../netatmo/write-endpoints.js';
import { systemClock, type Clock } from '../utils/clock.js';
import { formatIso, parseIsoInZone } from '../utils/dates.js';
import type { AuditLog } from './audit-log.js';
import { ref, zone, type CallOptions } from './energy-service.js';
import { toHomeSnapshot } from './heating/snapshot.js';
import {
  applySchedulePatch,
  describeScheduleChanges,
  findSchedule,
  heatingSchedules,
  scheduleView,
  toApiSchedule,
  type SchedulePatch,
  type ScheduleView,
} from './heating/schedule.js';
import { findRoom, selectHome, toHomes, type Home } from './homes/topology.js';
import type { HomeRef } from './views.js';

export interface ChangePlan {
  action: string;
  /** One line, used as the confirmation question. */
  title: string;
  /** Human-readable before → after lines. */
  changes: string[];
  warnings: string[];
  /** Parameters sent to Netatmo (no secrets), also written to the change log. */
  request: Record<string, unknown>;
  apply(options?: CallOptions): Promise<Record<string, unknown>>;
}

const MAX_MODE_C = 30;
const MODE_LABEL: Record<string, string> = {
  schedule: 'schedule',
  away: 'away',
  hg: 'frost guard',
};

export class ControlService {
  private readonly clock: Clock;

  constructor(
    private readonly client: NetatmoClient,
    private readonly limits: WriteLimits,
    private readonly audit: AuditLog,
    clock?: Clock,
  ) {
    this.clock = clock ?? systemClock;
  }

  // ------------------------------------------------------------------ read

  async getSchedules(
    homeId?: string,
    opts: CallOptions = {},
  ): Promise<{ home: HomeRef; schedules: ScheduleView[] }> {
    const home = await this.home(homeId, opts);
    return { home: ref(home), schedules: heatingSchedules(home).map((s) => scheduleView(s, home)) };
  }

  // ------------------------------------------------------------- room setpoint

  async planRoomSetpoint(
    input: {
      home_id?: string | undefined;
      room_id?: string | undefined;
      room_name?: string | undefined;
      mode: 'manual' | 'max' | 'schedule';
      temperature?: number | undefined;
      duration_minutes?: number | undefined;
      until?: string | undefined;
    },
    opts: CallOptions = {},
  ): Promise<ChangePlan> {
    const home = await this.home(input.home_id, opts);
    const tz = zone(home);
    const room = findRoom(home, {
      ...(input.room_id !== undefined && { roomId: input.room_id }),
      ...(input.room_name !== undefined && { roomName: input.room_name }),
    });
    const status = await this.client.homeStatus(home.id, opts);
    const snap = toHomeSnapshot(status.body, status.timeServer, this.clock.now());
    const current = snap.rooms.find((r) => r.roomId === room.id);
    const before = `${current?.setpointC ?? '?'} °C (${current?.setpointMode ?? 'unknown mode'})`;
    const temperatureNote =
      current?.temperatureC != null ? ` Current temperature: ${current.temperatureC} °C.` : '';

    if (input.mode === 'schedule') {
      const request = { home_id: home.id, room_id: room.id, mode: 'home' };
      return this.plan({
        action: 'set_room_setpoint',
        title: `Return ${room.name} to its schedule?`,
        changes: [`${room.name}: ${before} → follows the schedule.${temperatureNote}`],
        warnings: [],
        endpoint: 'setroomthermpoint',
        request,
      });
    }

    let temp: number;
    if (input.mode === 'max') {
      if (this.limits.maxTemp < MAX_MODE_C) {
        throw new InvalidArgumentError(
          `"max" mode heats to ${MAX_MODE_C} °C, above the configured maximum of ${this.limits.maxTemp} °C.`,
          {
            hint: 'Use mode "manual" with a temperature, or set NETATMO_MCP_MAX_TEMP=30 to allow it.',
          },
        );
      }
      temp = MAX_MODE_C;
    } else {
      if (input.temperature === undefined) {
        throw new InvalidArgumentError('A temperature is required for mode "manual".');
      }
      this.checkTemp(input.temperature);
      temp = input.temperature;
    }
    const end = this.endTime(input, tz);
    const request = {
      home_id: home.id,
      room_id: room.id,
      mode: input.mode,
      ...(input.mode === 'manual' && { temp }),
      endtime: end,
    };
    return this.plan({
      action: 'set_room_setpoint',
      title: `Set ${room.name} to ${temp} °C until ${formatIso(end, tz)}?`,
      changes: [
        `${room.name}: ${before} → ${temp} °C (${input.mode}) until ${formatIso(end, tz)}, then back to the schedule.${temperatureNote}`,
      ],
      warnings: [],
      endpoint: 'setroomthermpoint',
      request,
    });
  }

  // ------------------------------------------------------------------ home mode

  async planHomeMode(
    input: {
      home_id?: string | undefined;
      mode: 'schedule' | 'away' | 'frost_guard';
      until?: string | undefined;
      schedule_id?: string | undefined;
      schedule_name?: string | undefined;
    },
    opts: CallOptions = {},
  ): Promise<ChangePlan> {
    const home = await this.home(input.home_id, opts);
    const tz = zone(home);
    const apiMode = input.mode === 'frost_guard' ? 'hg' : input.mode;
    const warnings: string[] = [];
    const request: Record<string, unknown> = { home_id: home.id, mode: apiMode };
    let detail = '';

    if (input.until !== undefined) {
      if (apiMode === 'schedule') {
        throw new InvalidArgumentError('"until" only applies to the away and frost-guard modes.');
      }
      const end = parseIsoInZone(input.until, tz);
      const now = Math.floor(this.clock.now() / 1000);
      if (end <= now + 60) throw new InvalidArgumentError('"until" must be in the future.');
      if (end > now + 365 * 86_400)
        throw new InvalidArgumentError('"until" must be within a year.');
      request.endtime = end;
      detail = ` until ${formatIso(end, tz)}`;
    }
    if (input.schedule_id !== undefined || input.schedule_name !== undefined) {
      if (apiMode !== 'schedule') {
        throw new InvalidArgumentError('A schedule can only be chosen with mode "schedule".');
      }
      const schedule = findSchedule(home, input);
      request.schedule_id = schedule.id;
      detail = ` using schedule "${schedule.name ?? schedule.id}"`;
      warnings.push(
        'Choosing a schedule here uses an undocumented Netatmo parameter (experimental).',
      );
    }
    const from = MODE_LABEL[home.thermMode ?? ''] ?? home.thermMode ?? 'unknown';
    return this.plan({
      action: 'set_home_mode',
      title: `Switch ${home.name} to ${MODE_LABEL[apiMode] ?? apiMode} mode${detail}?`,
      changes: [`Home mode: ${from} → ${MODE_LABEL[apiMode] ?? apiMode}${detail}`],
      warnings,
      endpoint: 'setthermmode',
      request,
    });
  }

  // ------------------------------------------------------------ switch schedule

  async planSwitchSchedule(
    input: {
      home_id?: string | undefined;
      schedule_id?: string | undefined;
      schedule_name?: string | undefined;
    },
    opts: CallOptions = {},
  ): Promise<ChangePlan> {
    const home = await this.home(input.home_id, opts);
    if (!input.schedule_id && !input.schedule_name) {
      throw new InvalidArgumentError('Specify schedule_id or schedule_name.');
    }
    const target = findSchedule(home, input);
    if (target.selected) {
      throw new InvalidArgumentError(
        `"${target.name ?? target.id}" is already the active schedule.`,
      );
    }
    const active = heatingSchedules(home).find((s) => s.selected);
    return this.plan({
      action: 'switch_schedule',
      title: `Activate the schedule "${target.name ?? target.id}"?`,
      changes: [`Active schedule: "${active?.name ?? '?'}" → "${target.name ?? target.id}"`],
      warnings: [],
      endpoint: 'switchhomeschedule',
      request: { home_id: home.id, schedule_id: target.id },
    });
  }

  // -------------------------------------------------------- create / update

  async planCreateSchedule(
    input: SchedulePatch & {
      home_id?: string | undefined;
      name: string;
      based_on_schedule_id?: string | undefined;
      based_on_schedule_name?: string | undefined;
    },
    opts: CallOptions = {},
  ): Promise<ChangePlan> {
    const home = await this.home(input.home_id, opts);
    const base = findSchedule(home, {
      schedule_id: input.based_on_schedule_id,
      schedule_name: input.based_on_schedule_name,
    });
    const created = applySchedulePatch(base, home, input, this.limits);
    const changes = [
      `New schedule "${created.name ?? ''}", copied from "${base.name ?? base.id}"`,
      ...describeScheduleChanges(base, created, home).filter((c) => !c.startsWith('Name:')),
    ];
    return this.plan({
      action: 'create_schedule',
      title: `Create the schedule "${created.name ?? ''}"?`,
      changes,
      warnings: [
        'The new schedule is not activated; use netatmo_switch_schedule to activate it.',
        'Schedules can only be deleted in the Netatmo app, not through the API.',
      ],
      endpoint: 'createnewhomeschedule',
      request: { home_id: home.id, name: created.name ?? '' },
      body: toApiSchedule(created),
    });
  }

  async planUpdateSchedule(
    input: SchedulePatch & {
      home_id?: string | undefined;
      schedule_id?: string | undefined;
      schedule_name?: string | undefined;
    },
    opts: CallOptions = {},
  ): Promise<ChangePlan> {
    const home = await this.home(input.home_id, opts);
    const base = findSchedule(home, input);
    const updated = applySchedulePatch(base, home, input, this.limits);
    const changes = describeScheduleChanges(base, updated, home);
    if (changes.length === 0)
      throw new InvalidArgumentError('These values are already in place: nothing to change.');
    return this.plan({
      action: 'update_schedule',
      title: `Modify the schedule "${base.name ?? base.id}"${base.selected ? ' (active)' : ''}?`,
      changes,
      warnings: base.selected
        ? ['This is the active schedule: changes take effect immediately.']
        : [],
      endpoint: 'synchomeschedule',
      request: { home_id: home.id, schedule_id: base.id, name: updated.name ?? base.name ?? '' },
      body: toApiSchedule(updated),
    });
  }

  async planRenameSchedule(
    input: {
      home_id?: string | undefined;
      schedule_id?: string | undefined;
      schedule_name?: string | undefined;
      new_name: string;
    },
    opts: CallOptions = {},
  ): Promise<ChangePlan> {
    const home = await this.home(input.home_id, opts);
    const s = findSchedule(home, input);
    const name = input.new_name.trim();
    if (name === '' || name.length > 64)
      throw new InvalidArgumentError('Schedule names must be 1–64 characters.');
    return this.plan({
      action: 'rename_schedule',
      title: `Rename the schedule "${s.name ?? s.id}" to "${name}"?`,
      changes: [`Schedule name: "${s.name ?? ''}" → "${name}"`],
      warnings: ['Renaming uses an undocumented Netatmo endpoint (experimental).'],
      endpoint: 'renamehomeschedule',
      request: { home_id: home.id, schedule_id: s.id, name },
    });
  }

  // ------------------------------------------------------------- internals

  private async home(homeId: string | undefined, opts: CallOptions): Promise<Home> {
    return selectHome(toHomes((await this.client.homesData({}, opts)).body), homeId);
  }

  private checkTemp(t: number): void {
    if (!Number.isFinite(t) || t < this.limits.minTemp || t > this.limits.maxTemp) {
      throw new InvalidArgumentError(
        `The temperature must be between ${this.limits.minTemp} and ${this.limits.maxTemp} °C (got ${t}).`,
        { hint: 'Limits are set by NETATMO_MCP_MIN_TEMP / NETATMO_MCP_MAX_TEMP.' },
      );
    }
  }

  /** Manual/max setpoints are always temporary (ADR-0012): default 3 h, at most the limit. */
  private endTime(
    input: { duration_minutes?: number | undefined; until?: string | undefined },
    tz: string,
  ): number {
    const now = Math.floor(this.clock.now() / 1000);
    if (input.duration_minutes !== undefined && input.until !== undefined) {
      throw new InvalidArgumentError('Use either duration_minutes or until, not both.');
    }
    const end =
      input.until !== undefined
        ? parseIsoInZone(input.until, tz)
        : now + Math.round((input.duration_minutes ?? this.limits.defaultSetpointHours * 60) * 60);
    if (end < now + 5 * 60)
      throw new InvalidArgumentError('The setpoint must last at least 5 minutes.');
    if (end > now + this.limits.maxSetpointHours * 3600) {
      throw new InvalidArgumentError(
        `Manual setpoints may last at most ${this.limits.maxSetpointHours} h.`,
        { hint: 'The limit is set by NETATMO_MCP_MAX_SETPOINT_HOURS.' },
      );
    }
    return end;
  }

  private plan(p: {
    action: string;
    title: string;
    changes: string[];
    warnings: string[];
    endpoint: WriteEndpoint;
    request: Record<string, unknown>;
    body?: Record<string, unknown>;
  }): ChangePlan {
    const params = Object.fromEntries(
      Object.entries(p.request).map(([k, v]) => [k, v as string | number | undefined]),
    );
    return {
      action: p.action,
      title: p.title,
      changes: p.changes,
      warnings: p.warnings,
      request: p.body ? { ...p.request, schedule: p.body } : p.request,
      apply: async (options = {}) => {
        const time = new Date(this.clock.now()).toISOString();
        try {
          await this.client.write(p.endpoint, params, p.body, options);
        } catch (error) {
          await this.audit.record({
            time,
            action: p.action,
            params: p.request,
            outcome: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        await this.audit.record({ time, action: p.action, params: p.request, outcome: 'applied' });
        return { status: 'applied', action: p.action, changes: p.changes, warnings: p.warnings };
      },
    };
  }
}
