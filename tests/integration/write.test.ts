import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, isWriteModeEnabled } from '../../src/app.js';
import { loadConfig } from '../../src/config/loader.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { silentLogger } from '../../src/utils/logger.js';
import { fakeFetch, json, type RecordedRequest } from '../helpers/fake-fetch.js';
import { fakeClock, fixture } from '../helpers/fakes.js';

const NOW_MS = 1_767_225_600_000; // 2026-01-01T00:00:00Z = 01:00 Paris
const NOW_S = NOW_MS / 1000;

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'nem-write-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

interface Recorded {
  path: string;
  query: Record<string, string>;
  form: Record<string, string>;
  body: unknown;
}

function netatmo(writes: Recorded[], failWrites = false) {
  return async (req: RecordedRequest & { rawBody?: string }) => {
    const p = req.url.pathname;
    if (p === '/api/homesdata') return json(fixture('homesdata.json'));
    if (p === '/api/homestatus') return json(fixture('homestatus.json'));
    if (req.method === 'POST') {
      writes.push({
        path: p,
        query: Object.fromEntries(req.url.searchParams),
        form: Object.fromEntries(req.form),
        body:
          req.headers.get('content-type') === 'application/json'
            ? JSON.parse(req.rawBody ?? '{}')
            : undefined,
      });
      return failWrites ? json({}, 503) : json({ status: 'ok', time_server: NOW_S });
    }
    return json({ error: { code: 31, message: 'not found' } }, 404);
  };
}

/** fakeFetch that also keeps the raw request body (for JSON payloads). */
function recordingFetch(handler: ReturnType<typeof netatmo>): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    return fakeFetch((req) => handler(Object.assign(req, { rawBody: body })))(input, init);
  };
}

async function setup(
  opts: {
    scope?: string[];
    elicitation?: 'accept' | 'decline';
    /** Protocol generation spoken by the client (default: the SDK client's default, 2025 era). */
    era?: 'legacy' | 'modern';
    env?: Record<string, string>;
    failWrites?: boolean;
  } = {},
) {
  const config = loadConfig({ NETATMO_MCP_CONFIG_DIR: dir, ...opts.env });
  const writes: Recorded[] = [];
  const f = recordingFetch(netatmo(writes, opts.failWrites));
  const rt0 = createRuntime(config, silentLogger, { fetch: f, clock: fakeClock(NOW_MS) });
  await rt0.store.update(() => ({
    version: 1,
    clientId: 'cid',
    clientSecret: 'sec',
    tokens: {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: NOW_MS + 3 * 3_600_000,
      obtainedAt: NOW_MS,
      scope: opts.scope ?? ['read_thermostat', 'write_thermostat'],
      clientId: 'cid',
    },
  }));
  const writeMode = isWriteModeEnabled(config, await rt0.store.read());
  const rt = createRuntime(config, silentLogger, {
    fetch: f,
    clock: fakeClock(NOW_MS),
    allowWrites: writeMode,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  // Same entry point as `serve`: negotiates both protocol eras.
  serveStdio(
    () =>
      createMcpServer(rt.service, rt.analytics, silentLogger, { control: rt.control, writeMode }),
    { transport: st },
  );
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    {
      ...(opts.elicitation && { capabilities: { elicitation: { form: {} } } }),
      ...(opts.era === 'modern' && { versionNegotiation: { mode: { pin: '2026-07-28' } } }),
    },
  );
  if (opts.elicitation) {
    client.setRequestHandler('elicitation/create', () =>
      opts.elicitation === 'accept'
        ? { action: 'accept', content: { confirm: true } }
        : { action: 'decline' },
    );
  }
  await client.connect(ct);
  return { client, writes, config };
}

const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: any;
    content: { text: string }[];
  };

const WRITE_TOOLS = [
  'netatmo_create_schedule',
  'netatmo_rename_schedule',
  'netatmo_set_home_mode',
  'netatmo_set_room_setpoint',
  'netatmo_switch_schedule',
  'netatmo_update_schedule',
];

describe('write mode activation', () => {
  it('registers no write tool with a read-only token', async () => {
    const { client } = await setup({ scope: ['read_thermostat'] });
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const w of WRITE_TOOLS) expect(names).not.toContain(w);
    expect(names).toContain('netatmo_get_schedules');
  });

  it('can be switched off with NETATMO_MCP_WRITE=0 even with a write token', async () => {
    const { client } = await setup({ env: { NETATMO_MCP_WRITE: '0' } });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => WRITE_TOOLS.includes(n))).toEqual([]);
  });

  it('registers write tools, annotated as not read-only, when the token has write_thermostat', async () => {
    const { client } = await setup();
    const tools = (await client.listTools()).tools.filter((t) => WRITE_TOOLS.includes(t.name));
    expect(tools.map((t) => t.name).sort()).toEqual(WRITE_TOOLS);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(false);
      expect(t.description).toMatch(/user must confirm/);
    }
  });
});

describe('two-step confirmation (clients without elicitation)', () => {
  it('previews, then applies only with the matching single-use token, and logs the change', async () => {
    const { client, writes, config } = await setup();
    const args = { room_name: 'sejour', mode: 'manual', temperature: 21, duration_minutes: 90 };
    const preview = await call(client, 'netatmo_set_room_setpoint', args);
    expect(preview.isError).toBeFalsy();
    expect(preview.structuredContent).toMatchObject({
      status: 'confirmation_required',
      action: 'set_room_setpoint',
    });
    expect(preview.structuredContent.changes[0]).toMatch(
      /Séjour: 20 °C \(schedule\) → 21 °C \(manual\) until 2026-01-01T02:30:00\+01:00/,
    );
    expect(writes).toHaveLength(0);

    const token = preview.structuredContent.confirmation_token as string;
    // A token cannot be reused for other arguments.
    const other = await call(client, 'netatmo_set_room_setpoint', {
      ...args,
      temperature: 25,
      confirmation_token: token,
    });
    expect(other.isError).toBe(true);
    expect(writes).toHaveLength(0);

    const preview2 = await call(client, 'netatmo_set_room_setpoint', args);
    const done = await call(client, 'netatmo_set_room_setpoint', {
      ...args,
      confirmation_token: preview2.structuredContent.confirmation_token,
    });
    expect(done.structuredContent).toMatchObject({ status: 'applied' });
    expect(writes).toEqual([
      {
        path: '/api/setroomthermpoint',
        query: {},
        form: {
          home_id: '000000000000000000000001',
          room_id: '1000000001',
          mode: 'manual',
          temp: '21',
          endtime: String(NOW_S + 5400),
        },
        body: undefined,
      },
    ]);
    // Single use.
    const again = await call(client, 'netatmo_set_room_setpoint', {
      ...args,
      confirmation_token: preview2.structuredContent.confirmation_token,
    });
    expect(again.isError).toBe(true);
    expect(writes).toHaveLength(1);

    const log = (await fs.readFile(path.join(config.paths.dir, 'changes.log'), 'utf8'))
      .trim()
      .split('\n');
    expect(JSON.parse(log[0]!)).toMatchObject({ action: 'set_room_setpoint', outcome: 'applied' });
  });
});

describe.each(['legacy', 'modern'] as const)('elicitation confirmation (%s protocol)', (era) => {
  it('applies the change when the user accepts in the client', async () => {
    const { client, writes } = await setup({ elicitation: 'accept', era });
    const res = await call(client, 'netatmo_set_home_mode', {
      mode: 'away',
      until: '2026-01-03T18:00',
    });
    expect(res.structuredContent).toMatchObject({ status: 'applied', action: 'set_home_mode' });
    expect(writes[0]).toMatchObject({
      path: '/api/setthermmode',
      form: {
        home_id: '000000000000000000000001',
        mode: 'away',
        endtime: String(Date.parse('2026-01-03T17:00:00Z') / 1000),
      },
    });
  });

  it('changes nothing when the user declines', async () => {
    const { client, writes } = await setup({ elicitation: 'decline', era });
    const res = await call(client, 'netatmo_set_home_mode', { mode: 'frost_guard' });
    expect(res.structuredContent).toMatchObject({ status: 'cancelled' });
    expect(writes).toHaveLength(0);
  });
});

describe('limits and validation', () => {
  it('enforces the 7–28 °C range, the 24 h maximum and refuses max mode at 28 °C', async () => {
    const { client, writes } = await setup();
    const tooHot = await call(client, 'netatmo_set_room_setpoint', {
      room_name: 'bureau',
      mode: 'manual',
      temperature: 29,
    });
    expect(JSON.parse(tooHot.content[0]!.text).error.message).toMatch(/between 7 and 28/);
    const tooLong = await call(client, 'netatmo_set_room_setpoint', {
      room_name: 'bureau',
      mode: 'manual',
      temperature: 20,
      duration_minutes: 25 * 60,
    });
    expect(JSON.parse(tooLong.content[0]!.text).error.message).toMatch(/at most 24 h/);
    const boost = await call(client, 'netatmo_set_room_setpoint', {
      room_name: 'bureau',
      mode: 'max',
    });
    expect(JSON.parse(boost.content[0]!.text).error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      hint: expect.stringContaining('NETATMO_MCP_MAX_TEMP=30'),
    });
    expect(writes).toHaveLength(0);
  });

  it('allows max mode when the maximum is raised to 30 °C', async () => {
    const { client } = await setup({ env: { NETATMO_MCP_MAX_TEMP: '30' } });
    const res = await call(client, 'netatmo_set_room_setpoint', {
      room_name: 'bureau',
      mode: 'max',
      duration_minutes: 30,
    });
    expect(res.structuredContent.status).toBe('confirmation_required');
  });
});

describe('schedules', () => {
  it('lists schedules with zones and a readable timetable', async () => {
    const { client } = await setup({ scope: ['read_thermostat'] });
    const res = await call(client, 'netatmo_get_schedules', {});
    expect(
      res.structuredContent.schedules.map((s: { name: string; active: boolean }) => [
        s.name,
        s.active,
      ]),
    ).toEqual([
      ['Hiver', true],
      ['Vacances', false],
    ]);
  });

  it('updates the active schedule with the full patched body', async () => {
    const { client, writes } = await setup({ elicitation: 'accept' });
    const res = await call(client, 'netatmo_update_schedule', {
      zone_temperatures: [{ zone: 'Confort', room: 'Bureau', temperature: 20.5 }],
    });
    expect(res.structuredContent).toMatchObject({ status: 'applied', action: 'update_schedule' });
    const w = writes[0]!;
    expect(w.path).toBe('/api/synchomeschedule');
    expect(w.query).toEqual({
      home_id: '000000000000000000000001',
      schedule_id: '000000000000000000000101',
      name: 'Hiver',
    });
    const body = w.body as {
      zones: { id: number; rooms: { id: string; therm_setpoint_temperature: number }[] }[];
      timetable: unknown[];
    };
    expect(
      body.zones[0]!.rooms.find((r) => r.id === '1000000004')!.therm_setpoint_temperature,
    ).toBe(20.5);
    expect(body.zones[0]!.rooms).toHaveLength(4);
    expect(body.timetable).toHaveLength(35);
  });

  it('creates a schedule from a copy, switches and renames', async () => {
    const { client, writes } = await setup({ elicitation: 'accept' });
    const created = await call(client, 'netatmo_create_schedule', {
      name: 'Télétravail',
      based_on_schedule_name: 'Vacances',
    });
    expect(created.structuredContent.warnings.join(' ')).toMatch(
      /only be deleted in the Netatmo app/,
    );
    expect(writes[0]).toMatchObject({
      path: '/api/createnewhomeschedule',
      query: { name: 'Télétravail' },
    });
    await call(client, 'netatmo_switch_schedule', { schedule_name: 'Vacances' });
    expect(writes[1]).toMatchObject({
      path: '/api/switchhomeschedule',
      form: { schedule_id: '000000000000000000000102' },
    });
    const already = await call(client, 'netatmo_switch_schedule', { schedule_name: 'Hiver' });
    expect(JSON.parse(already.content[0]!.text).error.message).toMatch(
      /already the active schedule/,
    );
    const renamed = await call(client, 'netatmo_rename_schedule', {
      schedule_name: 'Vacances',
      new_name: 'Absences',
    });
    expect(renamed.structuredContent.warnings.join(' ')).toMatch(/experimental/);
    expect(writes[2]).toMatchObject({
      path: '/api/renamehomeschedule',
      form: { name: 'Absences' },
    });
  });
});

describe('write failures', () => {
  it('never retries a write after a server error and says the outcome is unknown', async () => {
    const { client, writes, config } = await setup({ elicitation: 'accept', failWrites: true });
    const res = await call(client, 'netatmo_set_home_mode', { mode: 'schedule' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).error.message).toMatch(
      /may or may not have been applied/,
    );
    expect(writes).toHaveLength(1);
    const log = await fs.readFile(path.join(config.paths.dir, 'changes.log'), 'utf8');
    expect(JSON.parse(log.trim())).toMatchObject({ outcome: 'failed' });
  });
});
