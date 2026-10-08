import { describe, expect, it } from 'vitest';
import {
  applySchedulePatch,
  dayTimeToOffset,
  describeScheduleChanges,
  findSchedule,
  offsetToDayTime,
  scheduleView,
  toApiSchedule,
} from '../../../src/domain/heating/schedule.js';
import { toHomes, type Home } from '../../../src/domain/homes/topology.js';
import { homesDataBodySchema } from '../../../src/netatmo/schemas.js';
import { fixture } from '../../helpers/fakes.js';

const limits = { minTemp: 7, maxTemp: 28 };

function home(): Home {
  return toHomes(homesDataBodySchema.parse(fixture<{ body: unknown }>('homesdata.json').body))[0]!;
}

describe('timetable conversion', () => {
  it('converts minutes since Monday 00:00 to day and time and back', () => {
    expect(offsetToDayTime(0)).toEqual({ day: 'monday', time: '00:00' });
    expect(offsetToDayTime(1440 + 390)).toEqual({ day: 'tuesday', time: '06:30' });
    expect(offsetToDayTime(6 * 1440 + 1350)).toEqual({ day: 'sunday', time: '22:30' });
    expect(dayTimeToOffset('Tuesday', '6:30')).toBe(1830);
    expect(() => dayTimeToOffset('funday', '06:00')).toThrow(/Unknown day/);
    expect(() => dayTimeToOffset('monday', '25:00')).toThrow(/Invalid time/);
  });
});

describe('schedules', () => {
  it('finds the active schedule by default, or by name or ID', () => {
    const h = home();
    expect(findSchedule(h).name).toBe('Hiver');
    expect(findSchedule(h, { schedule_name: 'vacances' }).id).toBe('000000000000000000000102');
    expect(() => findSchedule(h, { schedule_name: 'nope' })).toThrow(/Schedules: Hiver, Vacances/);
  });

  it('renders a readable view with room names and a day/time timetable', () => {
    const v = scheduleView(findSchedule(home()), home());
    expect(v.zones[0]?.rooms[0]).toEqual({
      room_id: '1000000001',
      room_name: 'Séjour',
      temperature_c: 20,
    });
    expect(v.timetable.slice(0, 3)).toEqual([
      { day: 'monday', time: '00:00', zone: 'Nuit' },
      { day: 'monday', time: '06:30', zone: 'Confort' },
      { day: 'monday', time: '09:00', zone: 'Eco' },
    ]);
  });

  it('patches room temperatures in a zone and describes the change', () => {
    const h = home();
    const base = findSchedule(h);
    const next = applySchedulePatch(
      base,
      h,
      {
        zone_temperatures: [{ zone: 'confort', room: 'sejour', temperature: 21 }],
        away_temperature: 15,
      },
      limits,
    );
    expect(next.zones[0]?.rooms[0]?.setpointC).toBe(21);
    expect(base.zones[0]?.rooms[0]?.setpointC).toBe(20); // base untouched
    expect(describeScheduleChanges(base, next, h)).toEqual([
      'Away temperature: 14 → 15 °C',
      'Zone Confort, Séjour: 20 → 21 °C',
    ]);
  });

  it('replaces the timetable from day/time/zone entries', () => {
    const h = home();
    const next = applySchedulePatch(
      findSchedule(h),
      h,
      {
        timetable: [
          { day: 'monday', time: '07:00', zone: 'Confort' },
          { day: 'monday', time: '00:00', zone: 'Nuit' },
          { day: 'monday', time: '22:00', zone: '1' },
        ],
      },
      limits,
    );
    expect(next.timetable).toEqual([
      { zoneId: 1, mOffset: 0 },
      { zoneId: 0, mOffset: 420 },
      { zoneId: 1, mOffset: 1320 },
    ]);
  });

  it('rejects out-of-limit temperatures, unknown zones and invalid timetables', () => {
    const h = home();
    const base = findSchedule(h);
    expect(() =>
      applySchedulePatch(
        base,
        h,
        { zone_temperatures: [{ zone: 'Confort', room: 'Bureau', temperature: 29 }] },
        limits,
      ),
    ).toThrow(/between 7 and 28/);
    expect(() => applySchedulePatch(base, h, { frost_guard_temperature: 3 }, limits)).toThrow(
      /between 7 and 28/,
    );
    expect(() =>
      applySchedulePatch(
        base,
        h,
        { zone_temperatures: [{ zone: 'Sieste', room: 'Bureau', temperature: 18 }] },
        limits,
      ),
    ).toThrow(/No zone "Sieste"/);
    expect(() =>
      applySchedulePatch(
        base,
        h,
        { timetable: [{ day: 'monday', time: '06:00', zone: 'Confort' }] },
        limits,
      ),
    ).toThrow(/must start on Monday at 00:00/);
    expect(() =>
      applySchedulePatch(
        base,
        h,
        {
          timetable: [
            { day: 'monday', time: '00:00', zone: 'Nuit' },
            { day: 'monday', time: '00:00', zone: 'Eco' },
          ],
        },
        limits,
      ),
    ).toThrow(/same time/);
  });

  it('builds the Netatmo request body with every zone and room', () => {
    const body = toApiSchedule(findSchedule(home()));
    expect(body).toMatchObject({ away_temp: 14, hg_temp: 7 });
    expect(
      (body.zones as { id: number; rooms: unknown[] }[]).map((z) => [z.id, z.rooms.length]),
    ).toEqual([
      [0, 4],
      [1, 4],
      [4, 4],
    ]);
    expect((body.timetable as unknown[])[1]).toEqual({ zone_id: 0, m_offset: 390 });
  });
});
