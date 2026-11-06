export type PayPalEnv = 'sandbox' | 'live';

export const PAYPAL_BASE_URL: Record<PayPalEnv, string> = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  env?: PayPalEnv;
  /** Injected in tests. */
  fetch?: typeof fetch;
  /** Retries for 429 and 5xx responses (the first attempt is not counted). */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RequestOptions {
  /** A JSON body; ignored when rawBody is set. */
  body?: unknown;
  /** A body sent byte for byte (webhook verification needs the event exactly as received). */
  rawBody?: string;
  /** PayPal-Request-Id: makes the call idempotent. Required for every call that moves money. */
  requestId?: string;
  prefer?: 'return=representation' | 'return=minimal';
}

export interface PayPalErrorDetail {
  field?: string;
  issue?: string;
  description?: string;
}

export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorName: string | undefined,
    message: string,
    readonly debugId: string | undefined,
    readonly details: PayPalErrorDetail[],
  ) {
    super(`PayPal ${status}${errorName ? ` ${errorName}` : ''}: ${message}${debugId ? ` (debug_id ${debugId})` : ''}`);
    this.name = 'PayPalApiError';
  }

  /** True when PayPal names this issue anywhere in the error, e.g. INSTRUMENT_DECLINED. */
  hasIssue(issue: string): boolean {
    return this.errorName === issue || this.details.some((d) => d.issue === issue);
  }
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

export class PayPalClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | undefined;

  constructor(private readonly opts: PayPalClientOptions) {
    this.baseUrl = PAYPAL_BASE_URL[opts.env ?? 'sandbox'];
    this.fetchImpl = opts.fetch ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? Date.now;
  }

  /** Client-credentials token, cached until a minute before it expires (sandbox tokens last about 9 hours). */
  async accessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.token && this.token.expiresAt > this.now()) return this.token.value;
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
    const res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw await toError(res);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: this.now() + (json.expires_in - 60) * 1000 };
    return json.access_token;
  }

  async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, opts: RequestOptions = {}): Promise<T> {
    let refreshedToken = false;
    // A write is retried only when it carries a PayPal-Request-Id; without one a
    // retry after a lost response could move money twice.
    const retrySafe = method === 'GET' || Boolean(opts.requestId);
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      };
      let body: string | undefined;
      if (opts.rawBody !== undefined) body = opts.rawBody;
      else if (opts.body !== undefined) body = JSON.stringify(opts.body);
      // PayPal answers 415 to a write without a JSON Content-Type, even one with
      // no body (authorize, void, cancel a payout item).
      if (body !== undefined || method !== 'GET') headers['Content-Type'] = 'application/json';
      if (opts.requestId) headers['PayPal-Request-Id'] = opts.requestId;
      if (opts.prefer) headers.Prefer = opts.prefer;

      const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body });

      if (res.status === 401 && !refreshedToken) {
        refreshedToken = true;
        await this.accessToken(true);
        continue;
      }
      if (retrySafe && RETRYABLE.has(res.status) && attempt < this.maxRetries) {
        await this.sleep(retryDelayMs(res, attempt));
        continue;
      }
      if (!res.ok) throw await toError(res);
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }
}

function retryDelayMs(res: Response, attempt: number): number {
  const header = res.headers.get('retry-after');
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  return Math.min(500 * 2 ** attempt, 8_000);
}

async function toError(res: Response): Promise<PayPalApiError> {
  const debugHeader = res.headers.get('paypal-debug-id') ?? undefined;
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error body; keep the status.
  }
  const name = (json.name ?? json.error) as string | undefined;
  const message = (json.message ?? json.error_description ?? res.statusText ?? 'Request failed') as string;
  const debugId = (json.debug_id as string | undefined) ?? debugHeader;
  const details = Array.isArray(json.details) ? (json.details as PayPalErrorDetail[]) : [];
  return new PayPalApiError(res.status, name, message, debugId, details);
}
