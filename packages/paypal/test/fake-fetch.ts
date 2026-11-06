export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Responder = (req: RecordedRequest) => Response | Promise<Response>;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * A fetch stand-in: token requests always succeed (counted separately); every
 * other request takes the next responder in order.
 */
export function fakeFetch(responders: Responder[], tokenTtlSeconds = 32400) {
  const requests: RecordedRequest[] = [];
  let tokens = 0;
  const queue = [...responders];
  const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const req: RecordedRequest = { url, method: init.method ?? 'GET', headers, body: init.body as string | undefined };
    if (url.endsWith('/v1/oauth2/token')) {
      tokens++;
      return json(200, { access_token: `token-${tokens}`, expires_in: tokenTtlSeconds });
    }
    requests.push(req);
    // Like PayPal: a write without a JSON Content-Type is refused, even with no body.
    if (req.method !== 'GET' && req.headers['Content-Type'] !== 'application/json') {
      return json(415, { name: 'UNSUPPORTED_MEDIA_TYPE', message: 'The request payload is not supported', debug_id: 'fake415' });
    }
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected request: ${req.method} ${url}`);
    return next(req);
  };
  return {
    fetch: impl as unknown as typeof fetch,
    requests,
    tokenCount: () => tokens,
  };
}
