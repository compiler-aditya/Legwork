import { z } from 'zod';
import { fromPayPal, type Money } from '@legwork/core';
import type { Deal, PayoutTarget } from '@legwork/orchestrator';
import type { CallClaims } from './call-token';

/** The wallet name PayPal Payouts expects for Venmo; settled by the day-one payouts check. */
export const VENMO_WALLET = 'VENMO' as const;

const dollars = z
  .string()
  .trim()
  .transform((s) => s.replace(/^\$/, '').replace(/,/g, ''))
  .refine((s) => /^\d{1,6}(\.\d{1,2})?$/.test(s), 'a dollar amount like 34.00');

export const RecordQuoteSchema = z.object({
  in_stock: z.boolean(),
  price: z.union([z.literal(''), dollars]),
  ready_at: z.string().trim().max(200),
  item_offered: z.string().trim().max(300).optional().default(''),
  notes: z.string().trim().max(1000).optional().default(''),
  declined_ai_calls: z.boolean().optional().default(false),
});
export type RecordQuoteInput = z.infer<typeof RecordQuoteSchema>;

export interface Quote {
  inStock: boolean;
  price?: Money;
  readyAt: string;
  itemOffered?: string;
  notes?: string;
  declinedAiCalls: boolean;
}

export const ConfirmOrderSchema = z.object({
  item: z.string().trim().min(1).max(300),
  quantity: z.coerce.number().int().min(1).max(10_000),
  total: dollars,
  ready_at: z.string().trim().min(1).max(200),
  payout_method: z.enum(['this_phone_paypal', 'this_phone_venmo', 'email', 'venmo_handle']),
  payout_receiver: z.string().trim().max(254).optional().default(''),
});
export type ConfirmOrderInput = z.infer<typeof ConfirmOrderSchema>;

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export function toQuote(input: RecordQuoteInput): Quote {
  const quote: Quote = { inStock: input.in_stock, readyAt: input.ready_at, declinedAiCalls: input.declined_ai_calls };
  if (input.price !== '') quote.price = toMoney(input.price);
  if (input.item_offered) quote.itemOffered = input.item_offered;
  if (input.notes) quote.notes = input.notes;
  return quote;
}

/**
 * Turns what the agent heard into a Deal for the orchestrator. The errand,
 * business and default payout number come from the call's token, never from
 * the model.
 */
export function toDeal(claims: CallClaims, input: ConfirmOrderInput): Deal {
  return {
    businessId: claims.businessId,
    outreachId: claims.outreachId,
    item: input.item,
    quantity: input.quantity,
    total: toMoney(input.total),
    payout: payoutTarget(claims, input),
    pickupAt: input.ready_at,
  };
}

function payoutTarget(claims: CallClaims, input: ConfirmOrderInput): PayoutTarget {
  const receiver = input.payout_receiver;
  switch (input.payout_method) {
    case 'this_phone_paypal':
      return { type: 'PHONE', receiver: claims.dialled, wallet: 'PAYPAL' };
    case 'this_phone_venmo':
      return { type: 'PHONE', receiver: claims.dialled, wallet: VENMO_WALLET };
    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(receiver)) throw new ToolInputError('the email address did not come through; ask them to spell it again');
      return { type: 'EMAIL', receiver: receiver.toLowerCase(), wallet: 'PAYPAL' };
    case 'venmo_handle': {
      const handle = receiver.replace(/^@/, '');
      if (!/^[A-Za-z0-9_-]{5,30}$/.test(handle)) throw new ToolInputError('the Venmo handle did not come through; ask them to spell it again');
      return { type: 'USER_HANDLE', receiver: handle, wallet: VENMO_WALLET };
    }
  }
}

function toMoney(s: string): Money {
  const [whole, cents = ''] = s.split('.');
  return fromPayPal(`${whole}.${cents.padEnd(2, '0')}`, 'USD');
}

/** "$34.00" for what the agent says out loud (it reads it as dollars and cents). */
export function spoken(m: Money): string {
  return `$${(m.cents / 100).toFixed(2)}`;
}
