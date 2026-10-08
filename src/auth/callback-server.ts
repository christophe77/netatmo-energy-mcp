import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OAuthError, parseRedirectParams } from './oauth.js';

export interface CallbackServer {
  /** Resolves with the authorization code once a request with the right `state` arrives. */
  code: Promise<string>;
  /** Actual bound port (useful when port 0 was requested in tests). */
  port: number;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS: Record<string, string[]> = {
  localhost: ['127.0.0.1', '::1'],
  '127.0.0.1': ['127.0.0.1'],
  '[::1]': ['::1'],
};

/** Parse and check that a redirect URI can be served by a local one-shot callback server. */
export function parseLoopbackRedirectUri(redirectUri: string): {
  hosts: string[];
  port: number;
  pathname: string;
} {
  const url = new URL(redirectUri);
  const hosts = LOOPBACK_HOSTS[url.hostname];
  if (url.protocol !== 'http:' || !hosts) {
    throw new OAuthError(
      'unsupported_redirect_uri',
      `The redirect URI ${redirectUri} is not a local http:// address, so the automatic login flow cannot receive it.`,
      {
        hint: 'Use "login --manual", or register http://localhost:8977/callback in your Netatmo app.',
      },
    );
  }
  const port = url.port === '' ? 80 : Number(url.port);
  return { hosts, port, pathname: url.pathname };
}

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1f2937}</style>
<h1>${title}</h1><p>${body}</p></html>`;
}

/**
 * Start a one-shot HTTP server on the loopback interface(s) for the OAuth redirect (ADR-0003).
 * Requests with a wrong or missing `state` are answered with 400 and ignored, so a stray or
 * forged request cannot end the login. The server stops after the first valid callback,
 * after `timeoutMs`, or when `signal` aborts.
 */
export async function startCallbackServer(opts: {
  redirectUri: string;
  expectedState: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Override the port (tests). */
  port?: number;
}): Promise<CallbackServer> {
  const { hosts, port: uriPort, pathname } = parseLoopbackRedirectUri(opts.redirectUri);
  const port = opts.port ?? uriPort;
  const servers: http.Server[] = [];
  let settle: { resolve: (code: string) => void; reject: (e: Error) => void } | undefined;
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Avoid unhandled rejection warnings if the caller is not awaiting yet.
  code.catch(() => undefined);

  const handler: http.RequestListener = (req, res) => {
    // Reject DNS-rebinding style requests: the browser redirect always targets a loopback host.
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
      res.writeHead(400, PAGE_HEADERS).end(page('Bad request', 'Unexpected host.'));
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' || url.pathname !== pathname) {
      res.writeHead(404, PAGE_HEADERS).end(page('Not found', 'Nothing to see here.'));
      return;
    }
    try {
      const authCode = parseRedirectParams(url.searchParams, opts.expectedState);
      res
        .writeHead(200, PAGE_HEADERS)
        .end(
          page(
            'Netatmo Energy MCP is authorized',
            'You can close this tab and return to the terminal.',
          ),
        );
      settle?.resolve(authCode);
    } catch (error) {
      const oauth = error instanceof OAuthError ? error : undefined;
      if (oauth?.oauthCode === 'state_mismatch') {
        res
          .writeHead(400, PAGE_HEADERS)
          .end(
            page('Login link expired', 'Please use the most recent link shown in the terminal.'),
          );
        return;
      }
      res
        .writeHead(400, PAGE_HEADERS)
        .end(page('Authorization failed', 'Return to the terminal for details.'));
      settle?.reject(error as Error);
    }
  };

  let boundPort = port;
  for (const host of hosts) {
    const server = http.createServer(handler);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host, port: boundPort, exclusive: true }, () => {
          server.off('error', reject);
          resolve();
        });
      });
      boundPort = (server.address() as AddressInfo).port;
      servers.push(server);
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code;
      // IPv6 loopback may be unavailable; that's fine as long as one interface is bound.
      if (host === '::1' && (errno === 'EADDRNOTAVAIL' || errno === 'EAFNOSUPPORT')) continue;
      await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
      if (errno === 'EADDRINUSE') {
        throw new OAuthError(
          'port_in_use',
          `Port ${boundPort} is already in use, so the login callback cannot be received.`,
          { hint: 'Close the program using it, or use "login --manual".', cause: error },
        );
      }
      throw error;
    }
  }

  const close = async () => {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => {
              resolve();
            });
            s.closeAllConnections();
          }),
      ),
    );
  };
  const timer = setTimeout(
    () => {
      settle?.reject(
        new OAuthError('timeout', 'Timed out waiting for the Netatmo authorization redirect.'),
      );
    },
    opts.timeoutMs ?? 5 * 60_000,
  );
  const onAbort = () => settle?.reject(new OAuthError('aborted', 'Login was cancelled.'));
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  void code.finally(close).catch(() => undefined);

  return { code, port: boundPort, close };
}
