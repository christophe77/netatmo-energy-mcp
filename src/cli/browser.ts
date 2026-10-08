import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { system32 } from '../auth/secure-fs.js';

/**
 * Command used to open a URL. Absolute paths where they are fixed, so that a binary planted in
 * the current directory (searched first on Windows) or earlier on PATH cannot be started.
 */
export function browserCommand(
  platform: NodeJS.Platform = process.platform,
): [command: string, prefixArgs: string[]] {
  if (platform === 'win32') return [system32('rundll32.exe'), ['url.dll,FileProtocolHandler']];
  if (platform === 'darwin') return ['/usr/bin/open', []];
  // xdg-open's location varies between distributions; prefer the standard one.
  return [existsSync('/usr/bin/xdg-open') ? '/usr/bin/xdg-open' : 'xdg-open', []];
}

/**
 * Open `url` in the default browser without going through a shell, so characters such as
 * `&` in the query string are never interpreted. Returns false if no opener could be started.
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  const [command, prefix] = browserCommand(platform);
  try {
    const child = spawn(command, [...prefix, url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
