import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore } from '../../src/auth/credential-store.js';
import { runCli } from '../../src/cli/index.js';
import { configPaths } from '../../src/config/paths.js';
import { silentLogger } from '../../src/utils/logger.js';
import { fakeFetch, json, type RecordedRequest } from '../helpers/fake-fetch.js';
import { fixture } from '../helpers/fakes.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'nem-probe-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(dir, { recursive: true, force: true });
});

function series(begin: number, step: number, n: number, row: number[]) {
  const start = Math.ceil(begin / step) * step;
  return { status: 'ok', body: [{ beg_time: start, step_time: step, value: Array(n).fill(row) }] };
}

function api(req: RecordedRequest) {
  const q = req.url.searchParams;
  const begin = Number(q.get('date_begin'));
  switch (req.url.pathname) {
    case '/api/homesdata':
      return json(fixture('homesdata.json'));
    case '/api/homestatus':
      return json(fixture('homestatus.json'));
    case '/api/getroommeasure':
      return json(series(begin, q.get('scale') === '1day' ? 86_400 : 1800, 24, [20, 19, 0, 0]));
    case '/api/getmeasure':
      return json(
        q.get('scale') === '1day'
          ? series(begin, 86_400, 4, [240, 1200])
          : series(begin, q.get('scale') === '30min' ? 1800 : 3600, 96, [10, 50]),
      );
    default:
      return json({ error: { code: 31, message: 'Method not found' } }, 404);
  }
}

describe('probe command', () => {
  it('writes a sanitized report and responses without identifying data', async () => {
    const cfgDir = path.join(dir, 'cfg');
    await new CredentialStore(configPaths(cfgDir), silentLogger).update(() => ({
      version: 1,
      clientId: 'cid',
      clientSecret: 'sec',
      tokens: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        // Far in the future: fake time advances quickly while the loop below drives timers.
        expiresAt: Date.now() + 365 * 86_400_000,
        obtainedAt: Date.now(),
        scope: ['read_thermostat'],
        clientId: 'cid',
      },
    }));
    vi.stubGlobal('fetch', fakeFetch(api));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const outDir = path.join(dir, 'out');
    const lines: string[] = [];
    const state = { done: false };
    const run = runCli(
      ['probe', '--out', outDir],
      { NETATMO_MCP_CONFIG_DIR: cfgDir },
      {
        line: (t = '') => lines.push(t),
        error: (t) => lines.push(t),
      },
    ).finally(() => {
      state.done = true;
    });
    while (!state.done) {
      await vi.advanceTimersByTimeAsync(10_000);
      await new Promise((r) => setImmediate(r));
    }
    const code = await run;
    expect(lines.filter((l) => l.includes('!'))).toEqual([]);
    expect(code).toBe(0);

    const report = await fs.readFile(path.join(outDir, 'report.md'), 'utf8');
    const responses = await fs.readFile(path.join(outDir, 'responses.json'), 'utf8');
    await expect(fs.stat(path.join(outDir, 'responses.raw.json'))).rejects.toThrow();

    expect(report).toContain('Thermostat type **NATherm1**, bridged by **NAPlug**');
    expect(report).toContain('Valves (NRV): 4');
    expect(report).toMatch(/open_window \/ open_windows: both/);
    expect(report).toMatch(/on\+off per bucket .*median=60/);
    expect(report).toMatch(/Cross-check over \d+ full day\(s\)/);
    for (const text of [report, responses]) {
      for (const secret of [
        '70:ee:50:00:00',
        '000000000000000000000001',
        'Séjour',
        'Test Home',
        'example.com',
        '[2,48]',
        'access-1',
      ]) {
        expect(text).not.toContain(secret);
      }
    }
    // The report lists field names (e.g. 'coordinates'); responses must not contain location at all.
    expect(responses).not.toMatch(/coordinates|altitude/);
    expect(JSON.parse(responses)).toHaveLength(12);
  });
});
