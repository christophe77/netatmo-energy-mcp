import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/loader.js';
import { resolveConfigDir } from '../../src/config/paths.js';
import { DEFAULT_REDIRECT_URI } from '../../src/config/schema.js';

describe('resolveConfigDir', () => {
  it('uses %APPDATA% on Windows', () => {
    expect(
      resolveConfigDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', 'C:\\Users\\a'),
    ).toBe('C:\\Users\\a\\AppData\\Roaming\\netatmo-energy-mcp');
  });

  it('falls back to the profile Roaming dir on Windows without APPDATA', () => {
    expect(resolveConfigDir({}, 'win32', 'C:\\Users\\a')).toBe(
      'C:\\Users\\a\\AppData\\Roaming\\netatmo-energy-mcp',
    );
  });

  it('uses Application Support on macOS', () => {
    expect(resolveConfigDir({}, 'darwin', '/Users/a')).toBe(
      '/Users/a/Library/Application Support/netatmo-energy-mcp',
    );
  });

  it('honours an absolute XDG_CONFIG_HOME on Linux and ignores a relative one', () => {
    expect(resolveConfigDir({ XDG_CONFIG_HOME: '/x/cfg' }, 'linux', '/home/a')).toBe(
      '/x/cfg/netatmo-energy-mcp',
    );
    expect(resolveConfigDir({ XDG_CONFIG_HOME: 'rel' }, 'linux', '/home/a')).toBe(
      '/home/a/.config/netatmo-energy-mcp',
    );
  });

  it('lets NETATMO_MCP_CONFIG_DIR override everything', () => {
    expect(resolveConfigDir({ NETATMO_MCP_CONFIG_DIR: '/tmp/x', APPDATA: 'C:\\y' }, 'win32')).toBe(
      path.resolve('/tmp/x'),
    );
  });
});

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig({ NETATMO_MCP_CONFIG_DIR: '/tmp/nem' });
    expect(cfg.redirectUri).toBe(DEFAULT_REDIRECT_URI);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.envClient).toEqual({});
    expect(cfg.paths.credentials).toBe(path.join(path.resolve('/tmp/nem'), 'credentials.json'));
  });

  it('reads and trims client credentials, treating blanks as unset', () => {
    const cfg = loadConfig({
      NETATMO_MCP_CONFIG_DIR: '/tmp/nem',
      NETATMO_CLIENT_ID: '  abc ',
      NETATMO_CLIENT_SECRET: '   ',
    });
    expect(cfg.envClient).toEqual({ clientId: 'abc' });
  });

  it('rejects an invalid log level or redirect URI', () => {
    expect(() => loadConfig({ NETATMO_MCP_LOG_LEVEL: 'loud' })).toThrow(ConfigError);
    expect(() => loadConfig({ NETATMO_REDIRECT_URI: 'not a url' })).toThrow(ConfigError);
  });
});
