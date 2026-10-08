import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { READ_ONLY_SCOPES } from '../../../src/auth/oauth.js';
import { READ_ENDPOINTS } from '../../../src/netatmo/endpoints.js';

/** ADR-0002: v0.1 must not be able to change heating settings. */
describe('read-only guarantee', () => {
  it('allow-lists exactly the four documented read endpoints', () => {
    expect(Object.values(READ_ENDPOINTS).sort()).toEqual([
      '/getmeasure',
      '/getroommeasure',
      '/homesdata',
      '/homestatus',
    ]);
  });

  it('requests only the read_thermostat scope', () => {
    expect(READ_ONLY_SCOPES).toEqual(['read_thermostat']);
  });

  it('never mentions a Netatmo write endpoint or write scope in source code', () => {
    const forbidden =
      /setroomthermpoint|setthermmode|createnewhomeschedule|synchomeschedule|switchhomeschedule|renamehomeschedule|setstate|write_thermostat|write_smarther/i;
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
    const offenders = files.filter((f) => forbidden.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
