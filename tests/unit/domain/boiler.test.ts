import { describe, expect, it } from 'vitest';
import { boilerOnSeconds } from '../../../src/domain/heating/boiler.js';

describe('boilerOnSeconds (observed units, 2026-10-08)', () => {
  it('scales sub-daily samples (seconds per 600 s) to the bucket length', () => {
    expect(boilerOnSeconds('1hour', 300, 300)).toBe(1800); // on half the time
    expect(boilerOnSeconds('30min', 600, 0)).toBe(1800); // on the whole bucket
    expect(boilerOnSeconds('3hours', 0, 600)).toBe(0);
  });

  it('normalises by on + off to absorb sampling noise around 600', () => {
    expect(boilerOnSeconds('1hour', 301, 300)).toBeCloseTo(1802.99, 1);
  });

  it('assumes a 600 s sample when boileroff is missing', () => {
    expect(boilerOnSeconds('1hour', 150)).toBe(900);
  });

  it('uses daily and longer sums as seconds directly', () => {
    expect(boilerOnSeconds('1day', 17_666, 68_771)).toBe(17_666);
    expect(boilerOnSeconds('1week', 50_000)).toBe(50_000);
  });

  it('never invents a value', () => {
    expect(boilerOnSeconds('1hour', null, 600)).toBeNull();
    expect(boilerOnSeconds('1hour', 0, 0)).toBeNull();
  });
});
