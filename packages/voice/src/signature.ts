import { createHmac, timingSafeEqual } from 'node:crypto';

/** ElevenLabs refuses to replay older deliveries than this; so do we. */
export const SIGNATURE_TOLERANCE_SECS = 30 * 60;

/**
 * Checks an ElevenLabs webhook's `ElevenLabs-Signature` header, as the
 * official SDK's constructEvent does: the header is `t=<unix secs>,v0=<hex>`
 * and v0 is HMAC-SHA256 of `${t}.${rawBody}` under the webhook's secret.
 * Unlike the SDK it compares in constant time and also refuses timestamps
 * from the future.
 */
export function verifyElevenLabsSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  if (!header || !secret) return false;
  const parts = header.split(',').map((p) => p.trim());
  const t = parts.find((p) => p.startsWith('t='))?.slice(2);
  const v0 = parts.find((p) => p.startsWith('v0='));
  if (!t || !v0 || !/^\d{1,12}$/.test(t)) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > SIGNATURE_TOLERANCE_SECS) return false;
  const expected = Buffer.from(`v0=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`);
  const given = Buffer.from(v0);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Builds a header value; for tests and local replays of recorded webhooks. */
export function signElevenLabsBody(rawBody: string, secret: string, nowMs: number = Date.now()): string {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v0=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
}
