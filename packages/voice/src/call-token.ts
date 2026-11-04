import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A capability for one call. Legwork mints it before dialling and hands it to
 * ElevenLabs as a dynamic variable; the agent's tools send it back in a
 * header the model cannot see or change. The API trusts the errand, outreach
 * and dialled number in the token, never ids the model typed, so a confused
 * or manipulated agent cannot confirm a deal on another errand or redirect a
 * payout away from the number it actually called.
 */
export interface CallClaims {
  errandId: string;
  outreachId: string;
  businessId: string;
  /** 1 asks for a quote; 2 may confirm the order. */
  round: 1 | 2;
  /** The number Legwork dialled (E.164): the default payout destination. */
  dialled: string;
  /** Expiry, unix seconds. */
  exp: number;
}

const PREFIX = 'lwc1';

export function mintCallToken(secret: string, claims: Omit<CallClaims, 'exp'>, ttlSecs = 45 * 60, nowMs = Date.now()): string {
  if (secret.length < 32) throw new Error('CALL_TOKEN_SECRET must be at least 32 characters');
  const body: CallClaims = { ...claims, exp: Math.floor(nowMs / 1000) + ttlSecs };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${PREFIX}.${payload}.${sign(secret, payload)}`;
}

/** The claims, or undefined for a token that is malformed, forged or expired. */
export function verifyCallToken(secret: string, token: string | undefined, nowMs = Date.now()): CallClaims | undefined {
  if (!token) return undefined;
  const [prefix, payload, mac] = token.split('.');
  if (prefix !== PREFIX || !payload || !mac) return undefined;
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  let claims: CallClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as CallClaims;
  } catch {
    return undefined;
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < nowMs) return undefined;
  if (claims.round !== 1 && claims.round !== 2) return undefined;
  return claims;
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(`${PREFIX}.${payload}`).digest('base64url');
}
