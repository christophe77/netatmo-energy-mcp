import { homedir } from 'node:os';
import path from 'node:path';

export const APP_DIR_NAME = 'netatmo-energy-mcp';

export interface PathEnv {
  NETATMO_MCP_CONFIG_DIR?: string | undefined;
  APPDATA?: string | undefined;
  XDG_CONFIG_HOME?: string | undefined;
}

/**
 * Per-user configuration directory.
 *
 * - Windows: %APPDATA%\netatmo-energy-mcp
 * - macOS:   ~/Library/Application Support/netatmo-energy-mcp
 * - Linux:   $XDG_CONFIG_HOME/netatmo-energy-mcp (default ~/.config/netatmo-energy-mcp)
 *
 * `NETATMO_MCP_CONFIG_DIR` overrides all of the above.
 */
export function resolveConfigDir(
  env: PathEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const override = env.NETATMO_MCP_CONFIG_DIR?.trim();
  if (override) return path.resolve(override);

  if (platform === 'win32') {
    const appData = env.APPDATA?.trim() || path.win32.join(home, 'AppData', 'Roaming');
    return path.win32.join(appData, APP_DIR_NAME);
  }
  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', APP_DIR_NAME);
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(home, '.config');
  return path.posix.join(base, APP_DIR_NAME);
}

export interface ConfigPaths {
  dir: string;
  credentials: string;
  lock: string;
}

export function configPaths(dir: string): ConfigPaths {
  return {
    dir,
    credentials: path.join(dir, 'credentials.json'),
    lock: path.join(dir, 'credentials.lock'),
  };
}
