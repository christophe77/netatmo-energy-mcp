import { describe, expect, it } from 'vitest';
import { toHomeSnapshot } from '../../../src/domain/heating/snapshot.js';
import {
  estimateRequests,
  fetchPaged,
  HistoryService,
} from '../../../src/domain/history/history-service.js';
import {
  describeHeatingSetup,
  findRoom,
  selectHome,
  summarizeDevices,
  toHomes,
  type Home,
} from '../../../src/domain/homes/topology.js';
import type { NetatmoClient } from '../../../src/netatmo/client.js';
import { homesDataBodySchema, homeStatusBodySchema } from '../../../src/netatmo/schemas.js';
import { fixture } from '../../helpers/fakes.js';

function homes(): Home[] {
  const raw = fixture<{ body: unknown }>('homesdata.json');
  return toHomes(homesDataBodySchema.parse(raw.body));
}

describe('topology', () => {
  it('normalises homesdata and drops location and account data', () => {
    const [home] = homes();
    expect(home).toMatchObject({
      id: '000000000000000000000001',
      name: 'Test Home',
      timezone: 'Europe/Paris',
      thermMode: 'schedule',
      defaultManualDurationMin: 180,
    });
    expect(JSON.stringify(home)).not.toMatch(/coordinates|altitude|example\.com/);
    expect(home?.rooms.map((r) => r.id)).toEqual([
      '1000000001',
      '1000000002',
      '1000000003',
      '1000000004',
    ]);
    // module_ids missing on a room: derived from modules' room_id.
    expect(home?.rooms[3]?.moduleIds).toEqual(['70:ee:50:00:00:06']);
  });

  it('identifies the heating setup without assuming a thermostat model', () => {
    const setup = describeHeatingSetup(homes()[0]!);
    expect(setup.gateways.map((m) => m.type)).toEqual(['NAPlug']);
    expect(setup.thermostats.map((m) => m.type)).toEqual(['NATherm1']);
    expect(setup.valves).toHaveLength(4);
    expect(setup.boilerSource).toEqual({
      deviceId: '70:ee:50:00:00:01',
      moduleId: '70:ee:50:00:00:02',
      thermostatType: 'NATherm1',
    });
    expect(summarizeDevices(homes()[0]!)).toBe(
      '1 × Netatmo Thermostat Relay (NAPlug), 1 × Netatmo Smart Thermostat (NATherm1), 4 × Netatmo Smart Radiator Valve (NRV)',
    );
  });

  it('has no boiler source in a valves-only home', () => {
    const home = homes()[0]!;
    const valvesOnly = { ...home, modules: home.modules.filter((m) => m.type !== 'NATherm1') };
    expect(describeHeatingSetup(valvesOnly).boilerSource).toBeUndefined();
  });

  it('finds rooms by ID or by accent- and case-insensitive name', () => {
    const home = homes()[0]!;
    expect(findRoom(home, { roomName: 'sejour' }).id).toBe('1000000001');
    expect(findRoom(home, { roomName: 'BUREAU' }).id).toBe('1000000004');
    expect(findRoom(home, { roomId: '1000000002' }).name).toBe('Chambre parents');
    expect(() => findRoom(home, { roomName: 'chambre' })).toThrow(/several rooms/);
    expect(() => findRoom(home, { roomName: 'garage' })).toThrow(/No room named/);
  });

  it('selects the only home implicitly and requires an ID when there are several', () => {
    const [home] = homes();
    expect(selectHome([home!]).id).toBe(home!.id);
    expect(() => selectHome([home!, { ...home!, id: 'x' }])).toThrow(/specify home_id/);
    expect(() => selectHome([])).toThrow(/no homes/);
  });
});

describe('toHomeSnapshot', () => {
  it('normalises spelling variants and keeps missing values as null', () => {
    const raw = fixture<{ body: unknown; time_server: number }>('homestatus.json');
    const snap = toHomeSnapshot(homeStatusBodySchema.parse(raw.body), raw.time_server, 0);
    expect(snap.observedAt).toBe(1767225600_000);
    expect(snap.rooms[0]).toMatchObject({
      temperatureC: 20.4,
      setpointC: 20,
      openWindow: false,
      heatingDemandPercent: 0,
    });
    expect(snap.rooms[1]).toMatchObject({
      openWindow: true,
      heatingDemandPercent: 45,
      setpointMode: 'manual',
    });
    expect(snap.rooms[2]).toMatchObject({ temperatureC: null, setpointC: null, reachable: false });
    expect(snap.modules[1]).toMatchObject({
      type: 'NATherm1',
      boilerOn: true,
      batteryLevelMv: 4100,
      rfStrength: 70,
    });
    expect(snap.modules[2]).toMatchObject({ rfStrength: 82, boilerOn: null });
    expect(snap.modules[0]).toMatchObject({ wifiStrength: 61, firmwareRevision: '222' });
    expect(snap.deviceErrors).toEqual([{ id: '70:ee:50:00:00:05', code: 6 }]);
  });
});

describe('history paging', () => {
  const page = (from: number, n: number, step: number) =>
    Array.from({ length: n }, (_, i) => ({ t: from + i * step, values: [i] }));

  it('pages forward from the last returned timestamp until a short page', async () => {
    const calls: [number, number][] = [];
    const res = await fetchPaged({ begin: 0, end: 1800 * 2000 }, '30min', async (b, e) => {
      calls.push([b, e]);
      const remaining = Math.floor((e - b) / 1800) + 1;
      return { points: page(b, Math.min(1024, remaining), 1800), warnings: [] };
    });
    expect(calls).toEqual([
      [0, 3_600_000],
      [1800 * 1024, 3_600_000], // next page starts one step later, on the same grid
    ]);
    expect(res.requests).toBe(2);
    expect(res.points).toHaveLength(2001);
  });

  it('refuses ranges that would exceed the request cap', async () => {
    expect(estimateRequests({ begin: 0, end: 365 * 86_400 }, '30min')).toBe(18);
    await expect(
      fetchPaged({ begin: 0, end: 365 * 86_400 }, '30min', async () => ({
        points: [],
        warnings: [],
      })),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      hint: expect.stringContaining('coarser') as string,
    });
  });

  it('stops when the API does not advance', async () => {
    const res = await fetchPaged({ begin: 5000, end: 9_000_000 }, '1hour', async () => ({
      points: page(0, 1024, 1),
      warnings: [],
    }));
    expect(res.requests).toBe(1);
    expect(res.warnings[0]).toMatch(/paging stopped/);
  });

  it('reports boiler history as unsupported without a thermostat', async () => {
    const home = homes()[0]!;
    const valvesOnly = { ...home, modules: home.modules.filter((m) => m.type !== 'NATherm1') };
    const service = new HistoryService({} as NetatmoClient);
    await expect(
      service.boilerSeries({
        home: valvesOnly,
        scale: '1hour',
        types: ['boileron'],
        range: { begin: 0, end: 3600 },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });
});
