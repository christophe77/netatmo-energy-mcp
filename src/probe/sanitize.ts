/**
 * Replace identifying data in Netatmo API payloads with stable placeholders so that probe
 * output can be shared (compatibility reports) or turned into public test fixtures.
 *
 * - Device MACs, home IDs, room/schedule IDs → consistent fake IDs (same input, same output) in
 *   ranges real devices never use: 00:00:00:00:xx:xx, fa4e…, 9000000000+
 * - Home/room/module/schedule/zone names → "Home 1", "Room 2", …
 * - Location and account data (coordinates, altitude, country, user, emails, addresses) → removed
 * - Identifiers embedded in free text (error messages) → replaced
 * The IANA time zone is kept: it is needed to check day-bucket alignment and is coarse.
 * Numbers, types, modes and timestamps are kept: they are what validation needs.
 */

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const DIGITS = /^\d+$/;
/** MACs inside text, with ":" or "-" separators. */
const EMBEDDED_MAC = /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi;
/** 12-hex MACs without separators, as found in serial-number-like fields. */
const EMBEDDED_BARE_MAC = /\b[0-9a-f]{12}\b/gi;
const EMBEDDED_OBJECT_ID = /\b[0-9a-f]{24}\b/gi;

const DROP_KEYS = new Set([
  'coordinates',
  'country',
  'altitude',
  'user',
  'email',
  'mail',
  'city',
  'address',
  'street',
  'place',
  'location',
  'latitude',
  'longitude',
  'lat',
  'lon',
  'lng',
  'ip',
  'phone',
  'owner',
  'owners',
  'administrators',
]);

const ID_KEYS = new Set([
  'id',
  'home_id',
  'room_id',
  'bridge',
  'device_id',
  'module_id',
  'schedule_id',
  'module_ids',
  'modules_bridged',
  'module_bridged',
]);

const NAME_LABEL: Record<string, string> = {
  homes: 'Home',
  rooms: 'Room',
  modules: 'Module',
  schedules: 'Schedule',
  zones: 'Zone',
  home: 'Home',
};

export class Sanitizer {
  private readonly ids = new Map<string, string>();
  private readonly names = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  private next(kind: string): number {
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    return n;
  }

  /** Stable fake for an identifier, preserving its general shape. */
  id(value: string | number): string | number {
    const key = String(value);
    const known = this.ids.get(key);
    if (known !== undefined) return typeof value === 'number' ? Number(known) : known;
    let fake: string;
    if (MAC.test(key)) {
      const n = this.next('mac');
      fake = `00:00:00:00:${((n >> 8) & 0xff).toString(16).padStart(2, '0')}:${(n & 0xff).toString(16).padStart(2, '0')}`;
    } else if (OBJECT_ID.test(key)) {
      fake = `fa4e00000000000000000${this.next('oid').toString(16).padStart(3, '0')}`;
    } else if (DIGITS.test(key)) {
      fake = String(9_000_000_000 + this.next('num'));
    } else {
      fake = `id-${this.next('other')}`;
    }
    this.ids.set(key, fake);
    return typeof value === 'number' ? Number(fake) : fake;
  }

  private name(context: string, original: string): string {
    const label = NAME_LABEL[context] ?? 'Name';
    const key = `${label}:${original}`;
    let fake = this.names.get(key);
    if (!fake) {
      fake = `${label} ${this.next(`name:${label}`)}`;
      this.names.set(key, fake);
    }
    return fake;
  }

  /** Deep-sanitize any JSON value. `context` is the nearest enclosing array/object key. */
  value(input: unknown, context = '', key = ''): unknown {
    if (Array.isArray(input)) {
      return input.map((v) => (ID_KEYS.has(key) ? this.idLike(v) : this.value(v, key || context)));
    }
    if (input !== null && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) {
        if (DROP_KEYS.has(k.toLowerCase())) continue;
        if (ID_KEYS.has(k)) {
          out[k] = Array.isArray(v) ? v.map((x) => this.idLike(x)) : this.idLike(v);
        } else if (k === 'name' && typeof v === 'string') {
          out[k] = this.name(context, v);
        } else {
          out[k] = this.value(v, k, k);
        }
      }
      return out;
    }
    if (typeof input === 'string') {
      if (MAC.test(input) || OBJECT_ID.test(input)) return this.id(input);
      return this.text(input);
    }
    return input;
  }

  /**
   * Replace identifiers embedded in free text (e.g. Netatmo error messages): MAC addresses
   * with or without separators and 24-hex home/schedule IDs.
   */
  text(input: string): string {
    return input
      .replace(EMBEDDED_MAC, (m) => String(this.id(m.toLowerCase().replaceAll('-', ':'))))
      .replace(EMBEDDED_BARE_MAC, (m) => String(this.id(m.toLowerCase().replace(/(..)(?!$)/g, '$1:'))))
      .replace(EMBEDDED_OBJECT_ID, (m) => String(this.id(m.toLowerCase())));
  }

  private idLike(v: unknown): unknown {
    return typeof v === 'string' || typeof v === 'number' ? this.id(v) : this.value(v);
  }
}
