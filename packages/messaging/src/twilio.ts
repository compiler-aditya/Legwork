import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  /** The Legwork number (E.164), the same one the calls come from. */
  from: string;
  fetch?: typeof fetch;
}

export class TwilioApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'TwilioApiError';
  }
}

/** Sends texts with Twilio's Messages API. */
export class TwilioSms {
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: TwilioOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  async send(to: string, body: string): Promise<{ sid: string }> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.opts.accountSid)}/Messages.json`;
    const res = await this.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.opts.accountSid}:${this.opts.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: this.opts.from, Body: body }).toString(),
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
    if (!res.ok || !json.sid) throw new TwilioApiError(res.status, json.code, `Twilio ${res.status}: ${json.message ?? 'message not sent'}`);
    return { sid: json.sid };
  }
}

/**
 * Checks Twilio's X-Twilio-Signature on a webhook: base64 HMAC-SHA1, keyed by
 * the auth token, of the full URL Twilio called followed by every POST
 * parameter's name and value, sorted by name.
 */
export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!signature || !authToken) return false;
  const expected = Buffer.from(signTwilio(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function signTwilio(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

/** A TwiML reply that texts `message` back, or says nothing. */
export function twiml(message?: string): string {
  const escaped = message?.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${escaped ? `<Message>${escaped}</Message>` : ''}</Response>`;
}
