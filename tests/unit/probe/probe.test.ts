import { describe, expect, it } from 'vitest';
import {
  compareHourlyWithDaily,
  describeMeasureShape,
  onOffSums,
  spellingReport,
} from '../../../src/probe/analyze.js';
import { Sanitizer } from '../../../src/probe/sanitize.js';
import { fixture } from '../../helpers/fakes.js';

describe('Sanitizer', () => {
  it('removes identifying data and keeps structure and values', () => {
    const raw = fixture<object>('homesdata.json');
    const san = new Sanitizer();
    const out = JSON.stringify(san.value(raw));
    for (const secret of [
      '70:ee:50:00:00:02',
      '000000000000000000000001',
      'Séjour',
      'Test Home',
      'someone@example.com',
      'coordinates',
      'altitude',
      'Vanne',
      'Hiver',
      'Confort',
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('"type":"NATherm1"');
    expect(out).toContain('"therm_setpoint_temperature":20');
    expect(out).toContain('"timezone":"Europe/Paris"');
    expect(out).toContain('"name":"Room 1"');
    expect(out).toContain('"name":"Home 1"');
  });

  it('maps the same identifier consistently across payloads', () => {
    const san = new Sanitizer();
    const a = san.value({ id: 'aa:bb:cc:dd:ee:ff', bridge: 'aa:bb:cc:dd:ee:00' }) as Record<
      string,
      string
    >;
    const b = san.value({
      modules: [{ id: 'aa:bb:cc:dd:ee:ff' }],
      device_id: 'aa:bb:cc:dd:ee:00',
    }) as {
      modules: { id: string }[];
      device_id: string;
    };
    expect(b.modules[0]?.id).toBe(a.id);
    expect(b.device_id).toBe(a.bridge);
    expect(a.id).not.toBe(a.bridge);
    expect(a.id).toMatch(/^00:00:00:00:/);
  });

  it('keeps numeric room IDs numeric', () => {
    const out = new Sanitizer().value({ rooms: [{ id: 1234 }] }) as { rooms: { id: unknown }[] };
    expect(typeof out.rooms[0]?.id).toBe('number');
  });
});

describe('probe analysis', () => {
  it('describes measure body shapes', () => {
    expect(describeMeasureShape([{ beg_time: 0, step_time: 60, value: [[1], [2]] }])).toMatch(
      /segments .*1 segment\(s\), 2 values, 0 without step_time/,
    );
    expect(describeMeasureShape({ '1': [1], '2': [2] })).toMatch(/timestamp map .*2 entries/);
    expect(describeMeasureShape({ home: {} })).toMatch(/OTHER shape with keys: home/);
  });

  it('checks boileron + boileroff sums', () => {
    expect(
      onOffSums([
        { t: 0, values: [20, 40] },
        { t: 1, values: [0, 60] },
        { t: 2, values: [null, 60] },
      ]),
    ).toEqual({ n: 2, min: 60, median: 60, max: 60 });
  });

  it('cross-checks hourly against daily boiler minutes over fully covered days', () => {
    const hourly = Array.from({ length: 48 }, (_, i) => ({ t: i * 3600, values: [10, 50] }));
    const daily = [
      { t: 0, values: [240, 1200] },
      { t: 86_400, values: [240, 1200] },
      { t: 172_800, values: [0, 0] },
    ];
    expect(compareHourlyWithDaily(hourly, daily, 3600)).toEqual({
      days: 2,
      hourlyMinutes: 480,
      dailyMinutes: 480,
    });
  });

  it('reports which field spelling is in use', () => {
    const lines = spellingReport(new Set(['open_window', 'rf_strenght']));
    expect(lines[0]).toMatch(/library spelling/);
    expect(lines[1]).toMatch(/spec spelling/);
    expect(lines[2]).toMatch(/neither/);
  });
});
