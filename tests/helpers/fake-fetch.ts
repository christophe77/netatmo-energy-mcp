export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Headers;
  form: URLSearchParams;
}

export type Responder = (req: RecordedRequest) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * A scripted `fetch`: each call consumes the next responder (the last one repeats).
 * Records requests for assertions.
 */
export function fakeFetch(...responders: Responder[]) {
  const requests: RecordedRequest[] = [];
  let index = 0;
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body = typeof init?.body === 'string' ? init.body : '';
    const req: RecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      form: new URLSearchParams(body),
    };
    requests.push(req);
    if (init?.signal?.aborted) throw init.signal.reason;
    const responder = responders[Math.min(index++, responders.length - 1)];
    if (!responder) throw new Error('fakeFetch: no responder');
    return responder(req);
  };
  return Object.assign(fn, { requests });
}

export const NETATMO_TOKEN_A = 'aaaaaaaaaaaaaaaaaaaaaaaa|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const NETATMO_TOKEN_B = 'bbbbbbbbbbbbbbbbbbbbbbbb|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

export function tokenResponse(n: number, expiresIn = 10800) {
  return {
    access_token: `access-${n}`,
    refresh_token: `refresh-${n}`,
    expires_in: expiresIn,
    expire_in: expiresIn,
    scope: ['read_thermostat'],
  };
}
