import { spawn } from 'node:child_process';

/**
 * Open `url` in the default browser without going through a shell, so characters such as
 * `&` in the query string are never interpreted. Returns false if no opener could be started.
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  const [command, args] =
    platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
