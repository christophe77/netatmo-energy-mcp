import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime } from '../../src/app.js';
import { loadConfig } from '../../src/config/loader.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { silentLogger } from '../../src/utils/logger.js';
import { fakeFetch, json, type RecordedRequest } from '../helpers/fake-fetch.js';
import { fakeClock, fixture } from '../helpers/fakes.js';

/** 2026-01-01T00:00:00Z = 01:00 in Paris; matches the fixtures' time_server. */
const NOW_MS = 1_767_225_600_000;

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'nem-mcp-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const STEP: Record<string, number> = {
  '30min': 1800,
  '1hour': 3600,
  '3hours': 10_800,
  '1day': 86_400,
  '1week': 604_800,
};

interface ApiOptions {
  withoutThermostat?: boolean;
  /** Room 1000000002 runs 3 °C below a 20 °C setpoint, with one implausible spike. */
  anomalies?: boolean;
}

/** Fake Netatmo Energy API following the behaviour observed live (docs/api-capabilities.md §11). */
function api(opts: ApiOptions = {}) {
  return (req: RecordedRequest) => {
    const q = req.url.searchParams;
    switch (req.url.pathname) {
      case '/api/homesdata': {
        const data = fixture<{ body: { homes: { modules: { type: string }[] }[] } }>(
          'homesdata.json',
        );
        if (opts.withoutThermostat) {
          const home = data.body.homes[0]!;
          home.modules = home.modules.filter((m) => m.type !== 'NATherm1');
        }
        return json(data);
      }
      case '/api/homestatus':
        return json(fixture('homestatus.json'));
      case '/api/getroommeasure':
      case '/api/getmeasure': {
        const scale = q.get('scale') ?? '1hour';
        const step = STEP[scale]!;
        const begin = Number(q.get('date_begin'));
        const end = Number(q.get('date_end'));
        const types = (q.get('type') ?? '').split(',');
        const start = step >= 86_400 ? Math.ceil(begin / 86_400) * 86_400 - 3600 : begin;
        const n = Math.min(1024, Math.floor((end - start) / step) + 1);
        const value = Array.from({ length: n }, (_, i) =>
          types.map((t) => {
            const odd = opts.anomalies && q.get('room_id') === '1000000002';
            if (t === 'temperature' && odd) return i === 10 ? 45 : 17;
            if (t === 'sp_temperature' && odd) return 20;
            if (t === 'temperature') return 19 + (i % 4) * 0.5;
            if (t === 'sp_temperature') return i < n / 2 ? 19 : 20;
            if (t === 'boileron') return 100;
            if (t === 'boileroff') return 500;
            if (t === 'sum_boiler_on') return 14_400;
            if (t === 'sum_boiler_off') return 72_000;
            return null;
          }),
        );
        return json({
          status: 'ok',
          body: n > 0 ? [{ beg_time: start, step_time: step, value }] : [],
        });
      }
      default:
        return json({ error: { code: 31, message: 'Method not found' } }, 404);
    }
  };
}

async function connect(opts: ApiOptions & { loggedIn?: boolean } = {}) {
  const config = loadConfig({ NETATMO_MCP_CONFIG_DIR: dir });
  const f = fakeFetch(api(opts));
  const runtime = createRuntime(config, silentLogger, { fetch: f, clock: fakeClock(NOW_MS) });
  if (opts.loggedIn !== false) {
    await runtime.store.update(() => ({
      version: 1,
      clientId: 'cid',
      clientSecret: 'sec',
      tokens: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: NOW_MS + 3 * 3_600_000,
        obtainedAt: NOW_MS,
        scope: ['read_thermostat'],
        clientId: 'cid',
      },
    }));
  }
  const server = createMcpServer(runtime.service, runtime.analytics, silentLogger);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, f };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  return res as {
    isError?: boolean;
    structuredContent?: any;
    content: { type: string; text: string }[];
  };
}

const EXPECTED_TOOLS = [
  'netatmo_compare_rooms',
  'netatmo_detect_anomalies',
  'netatmo_get_boiler_history',
  'netatmo_get_device_status',
  'netatmo_get_heating_status',
  'netatmo_get_heating_summary',
  'netatmo_get_home',
  'netatmo_get_home_status',
  'netatmo_get_room_status',
  'netatmo_get_setpoint_history',
  'netatmo_get_temperature_history',
  'netatmo_list_devices',
  'netatmo_list_homes',
  'netatmo_list_rooms',
];

describe('MCP server', () => {
  it('lists exactly the read-only v0.1 tools, all annotated read-only with output schemas', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.description!.length, tool.name).toBeGreaterThan(40);
    }
    expect(tools.map((t) => t.name)).not.toContain('netatmo_get_heating_demand_history');
  });

  it('lists homes and resolves the heating setup', async () => {
    const { client } = await connect();
    const res = await call(client, 'netatmo_list_homes');
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.homes[0]).toMatchObject({
      name: 'Test Home',
      timezone: 'Europe/Paris',
      room_count: 4,
      boiler_history_available: true,
    });
    expect(JSON.parse(res.content[0]!.text)).toEqual(res.structuredContent);
    expect(res.content[0]!.text).not.toMatch(/coordinates|example\.com/);
  });

  it('returns room status by accent-insensitive name, with derived difference', async () => {
    const { client } = await connect();
    const res = await call(client, 'netatmo_get_room_status', { room_name: 'sejour' });
    expect(res.structuredContent.room).toMatchObject({
      room_name: 'Séjour',
      temperature_c: 20.4,
      setpoint_c: 20,
      difference_to_setpoint_c: 0.4,
      setpoint_mode: 'schedule',
      setpoint_end: '2026-01-01T02:00:00+01:00',
    });
    expect(res.structuredContent.observed_at).toBe('2026-01-01T01:00:00+01:00');
  });

  it('reports heating activity and device diagnostics', async () => {
    const { client } = await connect();
    const heating = await call(client, 'netatmo_get_heating_status');
    expect(heating.structuredContent).toMatchObject({
      boiler_on: true,
      boiler_source: 'NATherm1',
      rooms_requesting_heat: 1,
    });
    expect(heating.structuredContent.caveats.join(' ')).toMatch(/not boiler power/);

    const devices = await call(client, 'netatmo_get_device_status');
    const byType = (t: string) =>
      devices.structuredContent.devices.filter((d: { type: string }) => d.type === t);
    expect(byType('NATherm1')[0]).toMatchObject({
      boiler_on: true,
      battery_level_mv: 4100,
      rf_quality: 'high',
    });
    expect(byType('NRV').find((d: { id: string }) => d.id === '70:ee:50:00:00:05')).toMatchObject({
      error_codes: [6],
    });

    const status = await call(client, 'netatmo_get_home_status');
    expect(status.structuredContent.alerts.join(' ')).toMatch(
      /Open window detected in Chambre parents/,
    );
    expect(status.structuredContent.alerts.join(' ')).toMatch(/error code 6/);
  });

  it('returns aggregated temperature history with stats, chosen scale and bounded buckets', async () => {
    const { client, f } = await connect();
    const res = await call(client, 'netatmo_get_temperature_history', {
      room_name: 'bureau',
      period: 'last_7d',
    });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent;
    expect(out).toMatchObject({
      scale: '30min',
      mode: 'aggregated',
      unit: '°C',
      measure: 'temperature',
    });
    expect(out.stats).toMatchObject({ min: 19, max: 20.5, count: out.coverage.received_points });
    expect(out.buckets.length).toBeLessThanOrEqual(48);
    expect(out.range.from).toMatch(/\+01:00$/);
    expect(out.notes.join(' ')).toMatch(/chosen automatically/);
    const req = f.requests.find((r) => r.url.pathname === '/api/getroommeasure')!;
    // Bucket start aligned to the scale in local time, real_time=true.
    expect(Number(req.url.searchParams.get('date_begin')) % 1800).toBe(0);
    expect(req.url.searchParams.get('real_time')).toBe('true');
  });

  it('bounds detailed output and flags truncation', async () => {
    const { client } = await connect();
    const res = await call(client, 'netatmo_get_temperature_history', {
      room_id: '1000000001',
      period: 'last_24h',
      mode: 'detailed',
      max_points: 10,
    });
    expect(res.structuredContent.points).toHaveLength(10);
    expect(res.structuredContent.truncated).toBe(true);
  });

  it('summarises setpoint history as change periods', async () => {
    const { client } = await connect();
    const res = await call(client, 'netatmo_get_setpoint_history', {
      room_name: 'bureau',
      period: 'yesterday',
    });
    expect(res.structuredContent.measure).toBe('setpoint');
    expect(res.structuredContent.changes.map((c: { value: number }) => c.value)).toEqual([19, 20]);
  });

  it('converts boiler activity from observed seconds to heat-demand minutes', async () => {
    const { client } = await connect();
    const hourly = await call(client, 'netatmo_get_boiler_history', {
      period: 'yesterday',
      mode: 'summary',
    });
    expect(hourly.isError).toBeFalsy();
    // 100 s on per 600 s sample → 10 min per hour over the 24 buckets of yesterday.
    expect(hourly.structuredContent).toMatchObject({
      scale: '1hour',
      thermostat_type: 'NATherm1',
      heat_demand_fraction: 0.167,
    });
    expect(hourly.structuredContent.total_heat_demand_minutes).toBe(240);
    expect(hourly.structuredContent.caveats.join(' ')).toMatch(
      /not measured gas or energy consumption/,
    );

    const daily = await call(client, 'netatmo_get_boiler_history', {
      period: 'last_7d',
      scale: '1day',
    });
    const first = daily.structuredContent.buckets[0];
    expect(first).toMatchObject({ heat_demand_minutes: 240, fraction: 0.167 });
  });

  it('reports unsupported boiler history without a thermostat', async () => {
    const { client } = await connect({ withoutThermostat: true });
    const res = await call(client, 'netatmo_get_boiler_history');
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).error.code).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('returns actionable errors as tool results', async () => {
    const { client } = await connect();
    const missing = await call(client, 'netatmo_get_room_status', { room_name: 'garage' });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.content[0]!.text).error).toMatchObject({ code: 'NOT_FOUND' });

    const bad = await call(client, 'netatmo_get_temperature_history', {
      room_name: 'bureau',
      period: 'last_7d',
      from: '2025-12-01',
    });
    expect(JSON.parse(bad.content[0]!.text).error.code).toBe('INVALID_ARGUMENT');

    const tooFine = await call(client, 'netatmo_get_temperature_history', {
      room_name: 'bureau',
      from: '2025-02-01',
      scale: '30min',
    });
    expect(JSON.parse(tooFine.content[0]!.text).error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      hint: expect.stringContaining('coarser'),
    });

    const invalid = await call(client, 'netatmo_get_temperature_history', { period: 'last_year' });
    expect(invalid.isError).toBe(true);
  });

  it('asks for login when no credentials are stored, without crashing', async () => {
    const { client } = await connect({ loggedIn: false });
    const res = await call(client, 'netatmo_list_homes');
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).error).toMatchObject({
      code: 'AUTH_REQUIRED',
      hint: expect.stringContaining('netatmo-energy-mcp login'),
    });
  });

  it('exposes JSON resources and resource templates', async () => {
    const { client } = await connect();
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain('netatmo://homes');
    expect(uris).toContain('netatmo://homes/000000000000000000000001/status');
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual([
      'netatmo://homes/{homeId}/devices',
      'netatmo://homes/{homeId}/rooms',
      'netatmo://homes/{homeId}/status',
    ]);
    const read = await client.readResource({
      uri: 'netatmo://homes/000000000000000000000001/rooms',
    });
    const content = read.contents[0] as { mimeType: string; text: string };
    expect(content.mimeType).toBe('application/json');
    expect(JSON.parse(content.text).rooms).toHaveLength(4);
    await expect(client.readResource({ uri: 'netatmo://homes/unknown/rooms' })).rejects.toThrow();
  });

  it('provides prompts that separate observations from hypotheses', async () => {
    const { client } = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([
      'heating_anomaly_review',
      'heating_daily_report',
      'heating_efficiency_review',
      'room_comparison',
    ]);
    for (const p of prompts) {
      const res = await client.getPrompt({ name: p.name, arguments: {} });
      const text = (res.messages[0]!.content as { text: string }).text;
      expect(text).toMatch(/Observed data/);
      expect(text).toMatch(/Hypotheses/);
      expect(text).toMatch(/does not measure gas or energy consumption/);
    }
  });
});

describe('MCP analytics tools', () => {
  it('summarises a day per room with boiler heat-demand time', async () => {
    const { client } = await connect();
    const res = await call(client, 'netatmo_get_heating_summary');
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent;
    expect(out.scale).toBe('30min');
    expect(out.rooms).toHaveLength(4);
    expect(out.boiler).toMatchObject({ available: true, total_heat_demand_minutes: 240 });
    expect(out.boiler.note).toMatch(/Not gas or energy consumption/);
    const room = out.rooms[0];
    expect(room.temperature).toMatchObject({ min: 19, max: 20.5 });
    const t = room.time_vs_target as Record<
      'below_minutes' | 'within_minutes' | 'above_minutes' | 'evaluated_minutes',
      number
    >;
    expect(t.below_minutes + t.within_minutes + t.above_minutes).toBe(t.evaluated_minutes);
    expect(out.caveats.join(' ')).toMatch(/Outdoor temperature is not available/);
  });

  it('reports the boiler as unavailable in a valves-only home', async () => {
    const { client } = await connect({ withoutThermostat: true });
    const res = await call(client, 'netatmo_get_heating_summary', { room_name: 'bureau' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.boiler).toMatchObject({
      available: false,
      total_heat_demand_minutes: null,
    });
    expect(res.structuredContent.rooms).toHaveLength(1);
  });

  it('compares rooms with rankings', async () => {
    const { client } = await connect({ anomalies: true });
    const res = await call(client, 'netatmo_compare_rooms', { period: 'last_7d' });
    expect(res.isError).toBeFalsy();
    const rankings = res.structuredContent.rankings as {
      metric: string;
      order: { room_name: string; value: number }[];
    }[];
    expect(rankings.map((r) => r.metric)).toEqual([
      'warmest',
      'coolest',
      'most_variable',
      'most_time_below_target',
      'largest_drop',
      'fastest_cooldown',
    ]);
    expect(rankings.find((r) => r.metric === 'most_time_below_target')!.order[0]!.room_name).toBe(
      'Chambre parents',
    );
    expect(rankings.find((r) => r.metric === 'coolest')!.order[0]!.room_name).toBe(
      'Chambre parents',
    );
  });

  it('detects anomalies with severity, confidence and evidence', async () => {
    const { client } = await connect({ anomalies: true });
    const res = await call(client, 'netatmo_detect_anomalies', { period: 'yesterday' });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent;
    expect(out.rooms_analysed).toHaveLength(4);
    const types = out.anomalies.map((a: { type: string }) => a.type);
    expect(types).toContain('out_of_range');
    expect(types).toContain('sustained_below_setpoint');
    for (const a of out.anomalies) {
      expect(a.room_name).toBe('Chambre parents');
      expect(a.explanation).not.toMatch(/broken|faulty|defective/i);
    }
    expect(out.anomalies[0].severity).toBe('high');
    expect(out.caveats[0]).toMatch(/not confirmed faults/);
  });

  it('finds nothing unusual in ordinary data and limits the range', async () => {
    const { client } = await connect();
    const res = await call(client, 'netatmo_detect_anomalies', { room_name: 'bureau' });
    expect(res.structuredContent.anomaly_count).toBe(0);
    const tooLong = await call(client, 'netatmo_detect_anomalies', { period: 'last_30d' });
    expect(JSON.parse(tooLong.content[0]!.text).error.code).toBe('INVALID_ARGUMENT');
  });
});
