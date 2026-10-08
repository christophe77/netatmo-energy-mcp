import fs from 'node:fs/promises';
import path from 'node:path';
import { createRuntime, type Runtime } from '../../app.js';
import {
  describeTokenResponseShape,
  InvalidGrantError,
  refreshAccessToken,
} from '../../auth/oauth.js';
import { ensureSecureDir, writeFileAtomic } from '../../auth/secure-fs.js';
import { resolveClientCredentials } from '../../auth/token-manager.js';
import { toHomeSnapshot } from '../../domain/heating/snapshot.js';
import {
  describeHeatingSetup,
  summarizeDevices,
  toHomes,
  type Home,
} from '../../domain/homes/topology.js';
import { AppError } from '../../errors.js';
import type { MeasureResult, RawExchange } from '../../netatmo/client.js';
import { SCALE_SECONDS } from '../../netatmo/endpoints.js';
import {
  alignment,
  compareHourlyWithDaily,
  describeMeasureShape,
  formatStats,
  keysByType,
  onOffSums,
  sortedKeys,
  spellingReport,
} from '../../probe/analyze.js';
import { Sanitizer } from '../../probe/sanitize.js';
import { VERSION } from '../../version.js';
import { parseCommandArgs, type Command, type CommandContext } from '../index.js';

const USAGE = `netatmo-energy-mcp probe [--days <n>] [--out <dir>] [--raw] [--refresh-test] [--rotation-test]

Makes a small number of read-only API calls (about 10–20, rate-limited to 4 per 10 s) and writes:
  report.md        Findings: device types, field names, response shapes, boiler unit checks
  responses.json   Sanitized API responses (IDs replaced, names generic, location removed)

  --days <n>         History window to sample (default 3, max 14)
  --out <dir>        Output folder (default: <config folder>/probe/<timestamp>)
  --raw              Also write responses.raw.json with UNSANITIZED data (keep it private)
  --refresh-test     Refresh the access token once and record the token response shape
  --rotation-test    After refreshing, try the previous refresh token again to check whether
                     Netatmo invalidates it immediately (implies --refresh-test)

Nothing is sent anywhere except api.netatmo.com. Review report.md before sharing it.`;

export const probeCommand: Command = {
  name: 'probe',
  summary: 'Record sanitized API responses for validation and device compatibility reports.',
  usage: USAGE,
  run: runProbe,
};

/** Conservative budget: stays below even the strictest reading of the per-app burst limit. */
const PROBE_RATE = [
  { limit: 4, windowMs: 10_000 },
  { limit: 60, windowMs: 3_600_000 },
];

async function runProbe({ config, out, logger, argv }: CommandContext): Promise<number> {
  const { values } = parseCommandArgs(argv, {
    days: { type: 'string', default: '3' },
    out: { type: 'string' },
    raw: { type: 'boolean', default: false },
    'refresh-test': { type: 'boolean', default: false },
    'rotation-test': { type: 'boolean', default: false },
  });
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 14) {
    out.error('--days must be an integer between 1 and 14.');
    return 2;
  }

  const exchanges: RawExchange[] = [];
  const runtime = createRuntime(config, logger, {
    rateWindows: PROBE_RATE,
    onExchange: (e) => exchanges.push(e),
  });
  const san = new Sanitizer();
  const errors: string[] = [];
  const md: string[] = [
    '# netatmo-energy-mcp probe report',
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- Version: ${VERSION}`,
    `- History window: ${days} day(s)`,
    '- Identifiers are replaced with placeholders; names are generic; location data is removed.',
  ];
  const h2 = (title: string) => md.push('', `## ${title}`, '');
  const attempt = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (error) {
      const msg = error instanceof AppError ? `${error.code}: ${error.message}` : String(error);
      errors.push(`${label}: ${msg}`);
      out.line(`  ! ${label}: ${msg}`);
      return undefined;
    }
  };

  out.line('Probing the Netatmo API (read-only, rate-limited; this takes about a minute)…');

  // ------------------------------------------------------------- tokens
  h2('Tokens');
  const stored = await runtime.store.read().catch(() => undefined);
  if (!stored?.tokens) {
    out.error('Not logged in. Run "netatmo-energy-mcp login" first.');
    return 1;
  }
  const lifetimeS = Math.round((stored.tokens.expiresAt - stored.tokens.obtainedAt) / 1000);
  md.push(`- Lifetime of the stored access token (expires_in at last issue): ${lifetimeS} s`);
  md.push(`- Granted scope: ${stored.tokens.scope.join(' ') || '(not reported)'}`);
  if (values['refresh-test'] || values['rotation-test']) {
    const lines = await attempt('refresh test', () =>
      refreshTest(runtime, config.envClient, values['rotation-test']),
    );
    md.push(...(lines ?? ['- Refresh test failed (see Errors).']));
  }

  // ----------------------------------------------------------- topology
  out.line('  homesdata…');
  const homesRes = await attempt('homesdata', () => runtime.client.homesData());
  if (!homesRes) return writeOutputs();
  const homes = toHomes(homesRes.body);
  const rawHomes = lastJson(exchanges, 'homesdata') as { body?: { homes?: unknown[] } } | undefined;
  h2('Topology (homesdata)');
  md.push(`- Homes with Energy data: ${homes.length}`);
  const rawHomeList = rawHomes?.body?.homes ?? [];
  md.push(`- Home object fields: ${sortedKeys(rawHomeList).join(', ')}`);
  const rawRooms = rawHomeList.flatMap((h) => (h as { rooms?: unknown[] }).rooms ?? []);
  const roomIdTypes = [...new Set(rawRooms.map((r) => typeof (r as { id?: unknown }).id))];
  md.push(`- Room ID JSON type(s): ${roomIdTypes.join(', ') || 'n/a'}`);
  md.push(`- Room fields: ${sortedKeys(rawRooms).join(', ')}`);
  const rawModules = rawHomeList.flatMap((h) => (h as { modules?: unknown[] }).modules ?? []);
  for (const [type, keys] of Object.entries(keysByType(rawModules))) {
    md.push(`- Module fields (${type}): ${keys.join(', ')}`);
  }

  const now = Math.floor(Date.now() / 1000);
  for (const home of homes) {
    await probeHome(home);
  }
  return writeOutputs();

  // ------------------------------------------------------------ helpers
  async function probeHome(home: Home): Promise<void> {
    const label = san.value({ name: home.name }, 'homes') as { name: string };
    const setup = describeHeatingSetup(home);
    h2(label.name);
    md.push(`- Time zone: ${home.timezone ?? 'not reported'}`);
    md.push(`- Rooms: ${home.rooms.length}`);
    md.push(`- Devices: ${summarizeDevices(home) || 'none'}`);
    for (const t of setup.thermostats) {
      const bridge = home.modules.find((m) => m.id === t.bridgeId);
      md.push(
        `- Thermostat type **${t.type}**, bridged by ${bridge ? `**${bridge.type}**` : 'nothing (self-bridged or unknown)'}`,
      );
    }
    for (const g of setup.gateways)
      md.push(`- Gateway type **${g.type}**, bridges ${g.bridgedIds.length} module(s)`);
    md.push(`- Valves (NRV): ${setup.valves.length}`);
    if (setup.other.length > 0)
      md.push(`- Other/unknown types: ${setup.other.map((m) => m.type).join(', ')}`);

    // homestatus
    out.line('  homestatus…');
    const status = await attempt('homestatus', () => runtime.client.homeStatus(home.id));
    if (status) {
      const raw = lastJson(exchanges, 'homestatus') as
        { body?: { home?: { rooms?: unknown[]; modules?: unknown[] } } } | undefined;
      const rooms = raw?.body?.home?.rooms ?? [];
      const modules = raw?.body?.home?.modules ?? [];
      md.push('', '### Current status (homestatus)', '');
      md.push(`- Room status fields: ${sortedKeys(rooms).join(', ')}`);
      for (const [type, keys] of Object.entries(keysByType(modules))) {
        md.push(`- Module status fields (${type}): ${keys.join(', ')}`);
      }
      const allKeys = new Set([
        ...sortedKeys(rooms),
        ...sortedKeys(modules),
        ...sortedKeys(rawHomeList),
        ...sortedKeys(rawModules),
      ]);
      md.push('- Spelling variants:', ...spellingReport(allKeys).map((l) => `  - ${l}`));
      const snap = toHomeSnapshot(status.body, status.timeServer, Date.now());
      const demand = snap.rooms.map((r) => r.heatingDemandPercent).filter((v) => v !== null);
      md.push(
        `- heating_power_request present for ${demand.length}/${snap.rooms.length} rooms (values: ${demand.join(', ') || 'none'})`,
      );
      md.push(
        `- boiler_status values: ${
          snap.modules
            .filter((m) => m.boilerOn !== null)
            .map((m) => `${m.type}=${String(m.boilerOn)}`)
            .join(', ') || 'not reported'
        }`,
      );
      md.push(
        `- Device errors: ${snap.deviceErrors.map((e) => `code ${e.code}`).join(', ') || 'none'}`,
      );
    }

    // room history
    md.push('', '### Room history (getroommeasure)', '');
    const begin = now - days * 86_400;
    for (const [i, room] of home.rooms.entries()) {
      out.line(`  getroommeasure room ${i + 1}/${home.rooms.length}…`);
      const roomLabel = (san.value({ name: room.name }, 'rooms') as { name: string }).name;
      const res = await attempt(`getroommeasure ${roomLabel}`, () =>
        runtime.client.getRoomMeasure({
          homeId: home.id,
          roomId: room.id,
          scale: '30min',
          types: ['temperature', 'sp_temperature'],
          dateBegin: begin,
          dateEnd: now,
        }),
      );
      md.push(
        `- ${roomLabel} (${room.type ?? 'no type'}), 30min temperature+sp_temperature: ${describeMeasureShape(bodyOf(lastJson(exchanges, 'getroommeasure')))}${res ? `; ${alignment(res.points, 1800, home.timezone)}` : ''}`,
      );
      if (i === 0) await probeRoomVariants(home, room.id, roomLabel, begin);
    }

    // boiler history
    md.push('', '### Boiler activity (getmeasure)', '');
    const source = setup.boilerSource;
    if (!source) {
      md.push('- No thermostat found: boiler history not available for this home.');
      return;
    }
    md.push(`- Source: thermostat type ${source.thermostatType} via its gateway`);
    const dayBegin = now - (days + 1) * 86_400;
    const q = {
      deviceId: source.deviceId,
      moduleId: source.moduleId,
      dateBegin: dayBegin,
      dateEnd: now,
    };
    out.line('  getmeasure boiler (1hour, 30min, 1day)…');
    const hourly = await attempt('getmeasure 1hour', () =>
      runtime.client.getMeasure({ ...q, scale: '1hour', types: ['boileron', 'boileroff'] }),
    );
    describeBoiler('1hour boileron,boileroff', hourly, home);
    const half = await attempt('getmeasure 30min', () =>
      runtime.client.getMeasure({ ...q, scale: '30min', types: ['boileron', 'boileroff'] }),
    );
    describeBoiler('30min boileron,boileroff', half, home);
    const daily = await attempt('getmeasure 1day', () =>
      runtime.client.getMeasure({
        ...q,
        scale: '1day',
        types: ['sum_boiler_on', 'sum_boiler_off'],
      }),
    );
    describeBoiler('1day sum_boiler_on,sum_boiler_off', daily, home);
    if (daily) {
      md.push(
        `  - Daily on+off sums (observed unit: seconds; 86400 = full day): ${formatStats(onOffSums(daily.points))}`,
      );
    }
    if (hourly && daily) {
      const cmp = compareHourlyWithDaily(hourly.points, daily.points);
      md.push(
        cmp
          ? `- Cross-check over ${cmp.days} full day(s): heat demand from hourly data = ${cmp.hourlyMinutes} min vs Σ daily sum_boiler_on = ${cmp.dailyMinutes} min`
          : '- Cross-check hourly vs daily: not enough overlapping data',
      );
    }
  }

  async function probeRoomVariants(home: Home, roomId: string, roomLabel: string, begin: number) {
    const base = { homeId: home.id, roomId, dateBegin: begin, dateEnd: now };
    const plain = await attempt('getroommeasure optimize=false', () =>
      runtime.client.getRoomMeasure({
        ...base,
        scale: '1hour',
        types: ['temperature'],
        optimize: false,
      }),
    );
    md.push(
      `- ${roomLabel}, 1hour optimize=false: ${describeMeasureShape(bodyOf(lastJson(exchanges, 'getroommeasure')))}${plain ? `; ${alignment(plain.points, 3600, home.timezone)}` : ''}`,
    );
    const centred = await attempt('getroommeasure real_time=false', () =>
      runtime.client.getRoomMeasure({
        ...base,
        scale: '1hour',
        types: ['temperature'],
        realTime: false,
      }),
    );
    md.push(
      `- ${roomLabel}, 1hour real_time=false: ${centred ? alignment(centred.points, 3600, home.timezone) : 'failed'}`,
    );
    const daily = await attempt('getroommeasure 1day min/max', () =>
      runtime.client.getRoomMeasure({
        ...base,
        dateBegin: now - 14 * 86_400,
        scale: '1day',
        types: ['min_temp', 'max_temp', 'date_min_temp', 'date_max_temp'],
      }),
    );
    md.push(
      `- ${roomLabel}, 1day min/max/date_min/date_max: ${describeMeasureShape(bodyOf(lastJson(exchanges, 'getroommeasure')))}${daily ? `; ${alignment(daily.points, 86_400, home.timezone)}` : ''}`,
    );
  }

  function describeBoiler(label: string, res: MeasureResult | undefined, home: Home) {
    if (!res) {
      md.push(`- ${label}: failed (see Errors)`);
      return;
    }
    md.push(`- ${label}: ${describeMeasureShape(bodyOf(lastJson(exchanges, 'getmeasure')))}`);
    md.push(`  - ${alignment(res.points, SCALE_SECONDS[res.scale], home.timezone)}`);
    if (res.scale !== '1day') {
      md.push(
        `  - on+off per bucket (observed unit: seconds per 600 s sample; ≈600 expected): ${formatStats(onOffSums(res.points))}`,
      );
    }
    if (res.warnings.length > 0) md.push(`  - Warnings: ${res.warnings.join('; ')}`);
  }

  async function writeOutputs(): Promise<number> {
    h2('Requests and rate limiting');
    md.push(`- Requests made: ${exchanges.length}`);
    const statuses = exchanges.reduce<Record<number, number>>((acc, e) => {
      acc[e.status] = (acc[e.status] ?? 0) + 1;
      return acc;
    }, {});
    md.push(
      `- HTTP statuses: ${Object.entries(statuses)
        .map(([s, n]) => `${s}×${n}`)
        .join(', ')}`,
    );
    const headerNames = new Set(exchanges.flatMap((e) => Object.keys(e.rateHeaders)));
    md.push(`- Rate-limit related response headers seen: ${[...headerNames].join(', ') || 'none'}`);
    h2('Errors');
    md.push(...(errors.length > 0 ? errors.map((e) => `- ${e}`) : ['- none']));

    const dir =
      values.out ??
      path.join(config.paths.dir, 'probe', new Date().toISOString().replace(/[:.]/g, '-'));
    await ensureSecureDir(config.paths.dir, logger);
    await fs.mkdir(dir, { recursive: true });
    const sanitized = exchanges.map((e) => ({
      endpoint: e.endpoint,
      query: san.value(e.query),
      status: e.status,
      rateHeaders: e.rateHeaders,
      json: san.value(e.json),
    }));
    // The report may contain names before this point only through the sanitizer.
    await writeFileAtomic(path.join(dir, 'report.md'), `${md.join('\n')}\n`);
    await writeFileAtomic(
      path.join(dir, 'responses.json'),
      `${JSON.stringify(sanitized, null, 2)}\n`,
    );
    if (values.raw) {
      await writeFileAtomic(
        path.join(dir, 'responses.raw.json'),
        `${JSON.stringify(exchanges, null, 2)}\n`,
      );
    }
    out.line();
    out.line(`Probe finished with ${errors.length} error(s). Output written to:`);
    out.line(`  ${dir}`);
    out.line(
      '  report.md, responses.json (sanitized)' +
        (values.raw ? ', responses.raw.json (PRIVATE, unsanitized)' : ''),
    );
    return errors.length === 0 ? 0 : 1;
  }
}

function lastJson(exchanges: RawExchange[], endpoint: RawExchange['endpoint']): unknown {
  for (let i = exchanges.length - 1; i >= 0; i--) {
    const e = exchanges[i];
    if (e?.endpoint === endpoint) return e.json;
  }
  return undefined;
}

function bodyOf(json: unknown): unknown {
  return json && typeof json === 'object' ? (json as { body?: unknown }).body : undefined;
}

/** Force one refresh (and optionally re-use the old refresh token) under the credentials lock. */
async function refreshTest(
  runtime: Runtime,
  envClient: { clientId?: string; clientSecret?: string },
  rotation: boolean,
): Promise<string[]> {
  return runtime.store.withLock(async () => {
    const stored = await runtime.store.read();
    const client = resolveClientCredentials(envClient, stored);
    const old = stored?.tokens;
    if (!stored || !client || !old) throw new Error('No stored credentials.');
    const first = await refreshAccessToken({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      refreshToken: old.refreshToken,
      now: Date.now(),
    });
    await runtime.store.writeUnlocked({ ...stored, tokens: first.tokens });
    const raw = first.raw as Record<string, unknown>;
    const lines = [
      `- Refresh response fields: ${Object.entries(describeTokenResponseShape(first.raw))
        .map(([k, t]) => `${k} (${t})`)
        .join(', ')}`,
      `- expires_in = ${String(raw.expires_in)}, expire_in = ${String(raw.expire_in)}`,
      `- New refresh token differs from the previous one: ${String(first.tokens.refreshToken !== old.refreshToken)}`,
      `- New access token differs from the previous one: ${String(first.tokens.accessToken !== old.accessToken)}`,
    ];
    if (!rotation) return lines;
    try {
      const second = await refreshAccessToken({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        refreshToken: old.refreshToken,
        now: Date.now(),
      });
      await runtime.store.writeUnlocked({ ...stored, tokens: second.tokens });
      lines.push(
        '- Rotation test: the PREVIOUS refresh token was still ACCEPTED (a grace period exists).',
      );
    } catch (error) {
      if (!(error instanceof InvalidGrantError)) throw error;
      lines.push(
        '- Rotation test: the previous refresh token was REJECTED (invalid_grant) — immediate invalidation confirmed.',
      );
    }
    return lines;
  });
}
