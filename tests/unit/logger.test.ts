import { describe, expect, it } from 'vitest';
import { createLogger, redact, redactText, REDACTED } from '../../src/utils/logger.js';

const TOKEN = '5a1b2c3d4e5f6a7b8c9d0e1f|0123456789abcdef0123456789abcdef';

describe('redaction', () => {
  it('redacts sensitive keys at any depth', () => {
    const out = redact({
      access_token: 'x',
      nested: { refreshToken: 'y', client_secret: 'z', keep: 'ok' },
      list: [{ Authorization: 'Bearer q' }],
    });
    expect(out).toEqual({
      access_token: REDACTED,
      nested: { refreshToken: REDACTED, client_secret: REDACTED, keep: 'ok' },
      list: [{ Authorization: REDACTED }],
    });
  });

  it('redacts Netatmo-shaped tokens and bearer headers inside free text', () => {
    expect(redactText(`token=${TOKEN} end`)).toBe(`token=${REDACTED} end`);
    expect(redactText('Authorization: Bearer abc.def')).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it('keeps Netatmo error codes (key "code") visible', () => {
    expect(redact({ code: 26, message: 'limit' })).toEqual({ code: 26, message: 'limit' });
  });
});

describe('createLogger', () => {
  it('filters by level and redacts metadata', () => {
    const lines: string[] = [];
    const log = createLogger({
      level: 'info',
      write: (l) => lines.push(l),
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    log.debug('hidden');
    log.info(`refreshed ${TOKEN}`, { refresh_token: TOKEN, expiresIn: 10800 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      `2026-01-01T00:00:00.000Z INFO  refreshed ${REDACTED} {"refresh_token":"${REDACTED}","expiresIn":10800}`,
    );
    expect(lines[0]).not.toContain('0123456789abcdef');
  });
});
