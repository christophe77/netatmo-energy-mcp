import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime } from '../../src/app.js';
import { loadConfig } from '../../src/config/loader.js';
import { toHomes } from '../../src/domain/homes/topology.js';
import { silentLogger } from '../../src/utils/logger.js';
import { fakeFetch, json, tokenResponse, type RecordedRequest } from '../helpers/fake-fetch.js';
import { fixture } from '../helpers/fakes.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'nem-int-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A minimal stand-in for api.netatmo.com: OAuth refresh + Energy read endpoints. */
function fakeNetatmo() {
  let issued = 1;
  return (req: RecordedRequest) => {
    const p = req.url.pathname;
    if (p === '/oauth2/token') {
      if (req.form.get('refresh_token') !== `refresh-${issued}`)
        return json({ error: 'invalid_grant' }, 400);
      issued += 1;
      return json(tokenResponse(issued));
    }
    if (req.headers.get('authorization') !== `Bearer access-${issued}`) {
      return json({ error: { code: 3, message: 'Access token expired' } }, 403);
    }
    if (p === '/api/homesdata') return json(fixture('homesdata.json'));
    if (p === '/api/getroommeasure') {
      const step = 1800;
      // Assumes buckets aligned to the scale (to be confirmed by live validation).
      const begin = Math.ceil(Number(req.url.searchParams.get('date_begin')) / step) * step;
      const end = Number(req.url.searchParams.get('date_end'));
      const n = Math.min(1024, Math.floor((end - begin) / step) + 1);
      const value = Array.from({ length: n }, (_, i) => [19 + (i % 10) / 10, 20]);
      return json({ status: 'ok', body: [{ beg_time: begin, step_time: step, value }] });
    }
    return json({ error: { code: 31, message: 'Method not found' } }, 404);
  };
}

describe('runtime integration', () => {
  it('refreshes an expired token, persists the rotation, and reads topology and paged history', async () => {
    const config = loadConfig({ NETATMO_MCP_CONFIG_DIR: dir });
    const f = fakeFetch(fakeNetatmo());
    const rt = createRuntime(config, silentLogger, { fetch: f });
    await rt.store.update(() => ({
      version: 1,
      clientId: 'cid',
      clientSecret: 'sec',
      tokens: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() - 1000,
        obtainedAt: Date.now() - 10_801_000,
        scope: ['read_thermostat'],
        clientId: 'cid',
      },
    }));

    const [home] = toHomes((await rt.client.homesData()).body);
    expect(home?.rooms).toHaveLength(4);
    expect((await rt.store.read())?.tokens?.refreshToken).toBe('refresh-2');

    const end = 1_767_225_600; // a multiple of 1800
    const begin = end - 30 * 86_400; // 1441 half-hour points → 2 pages
    const series = await rt.history.roomSeries({
      homeId: home!.id,
      roomId: home!.rooms[0]!.id,
      scale: '30min',
      types: ['temperature', 'sp_temperature'],
      range: { begin, end },
    });
    expect(series.requests).toBe(2);
    expect(series.points).toHaveLength(1441);
    expect(series.points[0]?.t).toBe(begin);
    expect(series.points.at(-1)?.t).toBe(end);
    expect(series.gaps).toEqual([]);

    const apiCalls = f.requests.filter((r) => r.url.pathname.startsWith('/api/'));
    expect(apiCalls.every((r) => r.method === 'GET')).toBe(true);
    expect(f.requests.filter((r) => r.url.pathname === '/oauth2/token')).toHaveLength(1);
  });
});
