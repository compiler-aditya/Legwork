import { usd, type Money } from '@legwork/core';
import type { OutreachPlan, OutreachRow } from './model';

export interface Pick {
  row: OutreachRow;
  quoted: Money;
  /** What to ask for on the confirmation call; equal to quoted when there is nothing to counter. */
  ask: Money;
}

export interface Choice {
  pick?: Pick;
  /** Why each other quote was passed over, for the timeline and the report. */
  skipped: Array<{ businessId: string; why: string }>;
}

/** The counter-offer never goes below this share of the shop's own price. */
export const COUNTER_FLOOR = 0.9;

/**
 * Picks the shop to call back: the cheapest in-stock quote that fits what
 * PayPal still holds, skipping shops already tried on round 2 (or that
 * cancelled). Ties keep the planner's order.
 */
export function chooseBest(input: { rows: OutreachRow[]; plan: OutreachPlan; held: Money; exclude: Set<string> }): Choice {
  const skipped: Choice['skipped'] = [];
  const order = new Map(input.plan.shops.map((s, i) => [s.businessId, i]));
  const candidates: Pick[] = [];
  for (const row of input.rows) {
    if (row.round !== 1 || row.result !== 'quoted' || !row.quote?.price) continue;
    if (input.exclude.has(row.businessId)) {
      skipped.push({ businessId: row.businessId, why: 'already tried' });
      continue;
    }
    if (row.quote.price.cents > input.held.cents) {
      skipped.push({ businessId: row.businessId, why: `quoted ${dollars(row.quote.price)}, above the ${dollars(input.held)} held` });
      continue;
    }
    candidates.push({ row, quoted: row.quote.price, ask: counterOffer(row.quote.price, input.plan.benchmark?.price) });
  }
  candidates.sort((a, b) => a.quoted.cents - b.quoted.cents || (order.get(a.row.businessId) ?? 99) - (order.get(b.row.businessId) ?? 99));
  const [pick, ...rest] = candidates;
  for (const r of rest) skipped.push({ businessId: r.row.businessId, why: `quoted ${dollars(r.quoted)}, more than ${dollars(pick!.quoted)}` });
  return pick ? { pick, skipped } : { skipped };
}

/**
 * When the online price is lower than the shop's, ask the shop to come down
 * towards it, but never below 90% of their own price, in whole dollars.
 */
export function counterOffer(quoted: Money, online?: Money): Money {
  if (!online || online.cents >= quoted.cents) return quoted;
  const floor = Math.ceil((quoted.cents * COUNTER_FLOOR) / 100) * 100;
  const ask = Math.max(floor, Math.ceil(online.cents / 100) * 100);
  return usd(Math.min(ask, quoted.cents));
}

export function dollars(m: Money): string {
  return `$${(m.cents / 100).toFixed(2)}`;
}
