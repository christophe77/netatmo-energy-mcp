import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { READ_ONLY_SCOPES, READ_WRITE_SCOPES } from '../../../src/auth/oauth.js';
import { NetatmoClient } from '../../../src/netatmo/client.js';
import { READ_ENDPOINTS } from '../../../src/netatmo/endpoints.js';
import { WRITE_ENDPOINTS } from '../../../src/netatmo/write-endpoints.js';
import { fakeFetch, json } from '../../helpers/fake-fetch.js';
import { FakeTokens } from '../../helpers/fakes.js';

/**
 * ADR-0002 / ADR-0012: read-only by default. Writing requires an explicit opt-in (login --write),
 * and write endpoints are only reachable through the dedicated, guarded client method.
 */
describe('read-only by default', () => {
  it('allow-lists exactly the four documented read endpoints for reads', () => {
    expect(Object.values(READ_ENDPOINTS).sort()).toEqual([
      '/getmeasure',
      '/getroommeasure',
      '/homesdata',
      '/homestatus',
    ]);
  });

  it('requests only the read_thermostat scope unless write mode is chosen', () => {
    expect(READ_ONLY_SCOPES).toEqual(['read_thermostat']);
    expect(READ_WRITE_SCOPES).toEqual(['read_thermostat', 'write_thermostat']);
  });

  it('keeps write endpoints in a single module, separate from read endpoints', () => {
    expect(Object.values(WRITE_ENDPOINTS).sort()).toEqual([
      '/createnewhomeschedule',
      '/renamehomeschedule',
      '/setroomthermpoint',
      '/setthermmode',
      '/switchhomeschedule',
      '/synchomeschedule',
    ]);
    for (const p of Object.values(WRITE_ENDPOINTS)) {
      expect(Object.values(READ_ENDPOINTS)).not.toContain(p);
    }
  });

  it('mentions write endpoints and the write scope only where write mode is implemented', () => {
    const forbidden =
      /setroomthermpoint|setthermmode|createnewhomeschedule|synchomeschedule|switchhomeschedule|renamehomeschedule|setstate|write_thermostat|write_smarther/i;
    // Write mode (ADR-0012): endpoint list, control service, schedule bodies, activation, login help.
    const allowed = new Set([
      'write-endpoints.ts',
      'control-service.ts',
      'schedule.ts',
      'app.ts',
      'login.ts',
    ]);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(path.join(import.meta.dirname, '..', '..', '..', 'src'));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter(
      (f) => !allowed.has(path.basename(f)) && forbidden.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
    // setstate is deliberately not exposed (ADR-0012).
    expect(
      readFileSync(
        path.join(import.meta.dirname, '..', '..', '..', 'src', 'netatmo', 'write-endpoints.ts'),
        'utf8',
      ),
    ).not.toMatch(/'\/setstate'/);
  });

  it('refuses every write unless the client was created with allowWrites', async () => {
    const f = fakeFetch(() => json({ status: 'ok' }));
    const client = new NetatmoClient({ tokens: new FakeTokens(), fetch: f });
    expect(client.writesAllowed).toBe(false);
    await expect(
      client.write('setthermmode', { home_id: 'h', mode: 'away' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(f.requests).toHaveLength(0);
  });
});
