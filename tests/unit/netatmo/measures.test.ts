import { describe, expect, it } from 'vitest';
import { decodeMeasureBody, findGaps } from '../../../src/netatmo/measures.js';
import { InvalidResponseError } from '../../../src/errors.js';

describe('decodeMeasureBody', () => {
  it('expands optimize=true segments, one value per requested type', () => {
    const body = [
      {
        beg_time: 1000,
        step_time: 1800,
        value: [
          [20.1, 19],
          [20.3, 19],
        ],
      },
      // A new segment after a data gap.
      { beg_time: 10_000, step_time: 1800, value: [[18.5, 17]] },
    ];
    const res = decodeMeasureBody(body, 2, 1800);
    expect(res.shape).toBe('segments');
    expect(res.points).toEqual([
      { t: 1000, values: [20.1, 19] },
      { t: 2800, values: [20.3, 19] },
      { t: 10_000, values: [18.5, 17] },
    ]);
  });

  it('accepts a single-value segment without step_time', () => {
    const res = decodeMeasureBody([{ beg_time: 5, value: [[1]] }], 1, 3600);
    expect(res.points).toEqual([{ t: 5, values: [1] }]);
    expect(res.warnings).toEqual([]);
  });

  it('assumes the scale step for a multi-value segment without step_time, with a warning', () => {
    const res = decodeMeasureBody([{ beg_time: 0, value: [[1], [2]] }], 1, 3600);
    expect(res.points.map((p) => p.t)).toEqual([0, 3600]);
    expect(res.warnings).toHaveLength(1);
  });

  it('decodes the optimize=false timestamp map, sorted', () => {
    const res = decodeMeasureBody({ '7200': [21], '3600': [20, 99] }, 1, 3600);
    expect(res.shape).toBe('map');
    expect(res.points).toEqual([
      { t: 3600, values: [20] },
      { t: 7200, values: [21] },
    ]);
  });

  it('pads missing values with null and never invents data', () => {
    const res = decodeMeasureBody([{ beg_time: 0, step_time: 60, value: [[null], [5]] }], 2, 60);
    expect(res.points).toEqual([
      { t: 0, values: [null, null] },
      { t: 60, values: [5, null] },
    ]);
  });

  it('de-duplicates overlapping points (first wins)', () => {
    const res = decodeMeasureBody(
      [
        { beg_time: 0, step_time: 60, value: [[1], [2]] },
        { beg_time: 60, step_time: 60, value: [[9], [3]] },
      ],
      1,
      60,
    );
    expect(res.points).toEqual([
      { t: 0, values: [1] },
      { t: 60, values: [2] },
      { t: 120, values: [3] },
    ]);
  });

  it('treats empty bodies as no data and rejects unknown shapes', () => {
    expect(decodeMeasureBody([], 1, 60).shape).toBe('empty');
    expect(decodeMeasureBody(undefined, 1, 60).points).toEqual([]);
    expect(() => decodeMeasureBody({ home: { values: [] } }, 1, 60)).toThrow(InvalidResponseError);
    expect(() => decodeMeasureBody('nope', 1, 60)).toThrow(InvalidResponseError);
  });
});

describe('findGaps', () => {
  const pts = (...ts: number[]) => ts.map((t) => ({ t, values: [1] }));

  it('reports intervals longer than 1.5 steps', () => {
    expect(findGaps(pts(0, 60, 120, 400, 460), 60)).toEqual([
      { after: 120, before: 400, missingPoints: 4 },
    ]);
  });

  it('reports missing data at the edges of the requested range', () => {
    expect(findGaps(pts(300, 360), 60, { begin: 0, end: 600 })).toEqual([
      { after: -60, before: 300, missingPoints: 5 },
      { after: 360, before: 660, missingPoints: 4 },
    ]);
  });

  it('reports a fully empty range as one gap', () => {
    expect(findGaps([], 60, { begin: 0, end: 120 })).toEqual([
      { after: -60, before: 180, missingPoints: 3 },
    ]);
  });
});
