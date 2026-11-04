import { randomInt } from 'node:crypto';

/**
 * PayPal-Request-Id makes money calls idempotent: the same id within PayPal's
 * window returns the first result instead of charging again. It must be
 * derived from the errand and the step, never random, so a retry after a
 * crash reuses it. PayPal allows up to 108 characters.
 */
export type MoneyStep =
  | 'hold'
  | 'authorize'
  | 'capture-deposit'
  | 'payout-deposit'
  | 'capture-balance'
  | 'payout-balance'
  | 'void'
  | 'refund-deposit'
  | 'reauthorize';

const SAFE = /[^A-Za-z0-9_-]/g;

export function requestIdFor(errandId: string, step: MoneyStep, attempt = 0): string {
  const id = `lw-${errandId.replace(SAFE, '')}-${step}${attempt ? `-${attempt}` : ''}`;
  if (id.length > 108) throw new Error(`PayPal-Request-Id too long: ${id.length} characters`);
  return id;
}

/** Payouts sender_item_id: stable per errand and step so a retried batch is recognised. */
export function senderItemIdFor(errandId: string, step: 'payout-deposit' | 'payout-balance'): string {
  return requestIdFor(errandId, step).slice(0, 63);
}

/** A four-digit code the shop reads back at pickup. */
export function newPickupCode(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0');
}
