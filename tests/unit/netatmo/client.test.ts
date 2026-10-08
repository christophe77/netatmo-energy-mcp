import { describe, expect, it } from 'vitest';
import { NetatmoClient } from '../../../src/netatmo/client.js';
import { RateLimiter } from '../../../src/netatmo/rate-limiter.js';
import { fakeFetch, json, type Responder } from '../../helpers/fake-fetch.js';
import { fakeClock, FakeTokens, fixture } from '../../helpers/fakes.js';

function setup(...responders: Responder[]) {
  const f = fakeFetch(...responders);
  const clock = fakeClock();
  const tokens = new FakeTokens();
  const client = new NetatmoClient({
    tokens,
    fetch: f,
    clock,
    random: () => 1,
    rateLimiter: new RateLimiter({ clock }),
  });
  return { client, f, clock, tokens };
}

const ok = (body: unknown) => () => json({ status: 'ok', body, time_server: 1767225600 });

describe('NetatmoClient requests', () => {
  it('calls homesdata with a bearer token and validates the body', async () => {
    const { client, f } = setup(() => json(fixture('homesdata.json')));
    const res = await client.homesData();
    expect(res.body.homes?.[0]?.rooms?.[1]?.id).toBe('1000000002'); // numeric ID coerced
    expect(res.timeServer).toBe(1767225600);
    const req = f.requests[0]!;
    expect(req.method).toBe('GET');
    expect(req.url.toString()).toBe('https://api.netatmo.com/api/homesdata');
    expect(req.headers.get('authorization')).toBe('Bearer token-1');
    expect(req.headers.get('user-agent')).toMatch(/^netatmo-energy-mcp\//);
  });

  it('builds getroommeasure queries with documented parameters', async () => {
    const { client, f } = setup(ok([{ beg_time: 1000, step_time: 1800, value: [[20, 19]] }]));
    const res = await client.getRoomMeasure({
      homeId: 'h',
      roomId: 'r',
      scale: '30min',
      types: ['temperature', 'sp_temperature'],
      dateBegin: 1000,
      dateEnd: 5000,
    });
    expect(res.points).toEqual([{ t: 1000, values: [20, 19] }]);
    expect(Object.fromEntries(f.requests[0]!.url.searchParams)).toEqual({
      home_id: 'h',
      room_id: 'r',
      scale: '30min',
      type: 'temperature,sp_temperature',
      date_begin: '1000',
      date_end: '5000',
      limit: '1024',
      optimize: 'true',
      real_time: 'true',
    });
  });

  it('rejects measure types that the scale does not support, before calling Netatmo', async () => {
    const { client, f } = setup(ok([]));
    await expect(
      client.getRoomMeasure({ homeId: 'h', roomId: 'r', scale: '1hour', types: ['date_min_temp'] }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      client.getMeasure({ deviceId: 'd', moduleId: 'm', scale: '1day', types: ['boileron'] }),
    ).rejects.toThrow(/sum_boiler_on/);
    await expect(
      client.getMeasure({ deviceId: 'd', moduleId: 'm', scale: '1hour', types: ['sum_boiler_on'] }),
    ).rejects.toThrow(/boileron/);
    expect(f.requests).toHaveLength(0);
  });

  it('refreshes once when the token is rejected, then retries', async () => {
    const { client, tokens, f } = setup(
      () => json({ error: { code: 3, message: 'Access token expired' } }, 403),
      ok({ homes: [] }),
    );
    await client.homesData();
    expect(tokens.rejected).toEqual(['token-1']);
    expect(f.requests.map((r) => r.headers.get('authorization'))).toEqual([
      'Bearer token-1',
      'Bearer token-2',
    ]);
  });

  it('gives up with AUTH_REQUIRED if the refreshed token is rejected too', async () => {
    const { client, f } = setup(() =>
      json({ error: { code: 2, message: 'Invalid access token' } }, 403),
    );
    await expect(client.homesData()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(f.requests).toHaveLength(2);
  });

  it('retries 5xx with exponential backoff', async () => {
    const { client, clock, f } = setup(
      () => json({}, 503),
      () => json({}, 502),
      ok({ homes: [] }),
    );
    await client.homesData();
    expect(f.requests).toHaveLength(3);
    expect(clock.sleeps).toEqual([500, 1000]);
  });

  it('honours Retry-After on 429', async () => {
    const { client, clock } = setup(
      () => json({ error: { code: 28, message: 'rate' } }, 429, { 'Retry-After': '7' }),
      ok({ homes: [] }),
    );
    await client.homesData();
    expect(clock.sleeps).toEqual([7000]);
  });

  it('does not retry an hourly usage limit and reports RATE_LIMITED', async () => {
    const { client, f } = setup(() =>
      json({ error: { code: 26, message: 'User usage reached' } }, 403),
    );
    await expect(client.homesData()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(f.requests).toHaveLength(1);
  });

  it('retries network failures and then reports NETATMO_UNAVAILABLE', async () => {
    const { client, f } = setup(() => {
      throw new TypeError('fetch failed');
    });
    await expect(client.homesData()).rejects.toMatchObject({ code: 'NETATMO_UNAVAILABLE' });
    expect(f.requests).toHaveLength(3);
  });

  it('does not retry client errors', async () => {
    const { client, f } = setup(() =>
      json({ error: { code: 21, message: 'Invalid argument' } }, 400),
    );
    await expect(client.homeStatus('h')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(f.requests).toHaveLength(1);
  });

  it('stops immediately when the caller aborts', async () => {
    const { client, f } = setup(ok({ homes: [] }));
    const ac = new AbortController();
    ac.abort(new Error('cancelled'));
    await expect(client.homesData({}, { signal: ac.signal })).rejects.toThrow('cancelled');
    expect(f.requests).toHaveLength(0);
  });

  it('reports INVALID_RESPONSE for non-JSON or unexpected payloads', async () => {
    const { client } = setup(() => new Response('<html>oops</html>', { status: 200 }));
    await expect(client.homesData()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const bad = setup(ok({ home: { rooms: [] } })); // home.id missing
    await expect(bad.client.homeStatus('h')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('caches topology and status, but never failures', async () => {
    const { client, f, clock } = setup(() => json({}, 400), ok({ homes: [] }));
    await expect(client.homesData()).rejects.toBeDefined();
    await client.homesData();
    await client.homesData();
    expect(f.requests).toHaveLength(2);
    clock.advance(11 * 60_000);
    await client.homesData();
    expect(f.requests).toHaveLength(3);
  });

  it('parses homestatus with spelling variants', async () => {
    const { client } = setup(() => json(fixture('homestatus.json')));
    const res = await client.homeStatus('000000000000000000000001');
    expect(res.body.home.modules?.[2]?.rf_strenght).toBe(82);
    expect(res.body.errors?.[0]?.code).toBe(6);
  });
});
