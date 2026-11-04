import type { ErrandEvent, ErrandState, Money } from '@legwork/core';
import type { RecipientType, RecipientWallet } from '@legwork/paypal';

/** Where a shop's money goes: the dialled phone number by default, or what the shop read out and confirmed by text. */
export interface PayoutTarget {
  type: Extract<RecipientType, 'EMAIL' | 'PHONE' | 'USER_HANDLE'>;
  receiver: string;
  wallet?: RecipientWallet;
}

/** What the voice agent's confirm_order tool hands over after round 2. */
export interface Deal {
  businessId: string;
  outreachId: string;
  item: string;
  quantity: number;
  total: Money;
  payout: PayoutTarget;
  pickupAt?: string;
}

export interface Contract {
  id: string;
  businessId: string;
  outreachId: string;
  item: string;
  quantity: number;
  total: Money;
  deposit: Money;
  pickupCode: string;
  payout: PayoutTarget;
  pickupAt?: string;
}

export type PayoutStatus = 'sent' | 'SUCCEEDED' | 'UNCLAIMED' | 'CANCELED' | 'RETURNED' | 'FAILED' | 'BLOCKED' | 'DENIED';

export interface Errand {
  id: string;
  userId: string;
  state: ErrandState;
  /** The buyer's maximum; the size of the hold. */
  budgetMax: Money;
  hold?: {
    orderId: string;
    authorizationId?: string;
    /** What PayPal still holds for us: the hold minus everything captured, refunds included. */
    remaining: Money;
  };
  contract?: Contract;
  captures: { deposit?: string; balance?: string };
  payouts: {
    deposit?: { batchId: string; senderItemId: string; itemId?: string; status: PayoutStatus };
    balance?: { batchId: string; senderItemId: string; itemId?: string; status: PayoutStatus };
  };
  /** Contracts that ended with a shop cancelling; kept for the receipt and the shop's reliability score. */
  cancelledContracts: Contract[];
  /** Set when something needs a person (a capture denied, a payout already claimed after a cancellation). */
  attention?: string;
}

export interface Transition {
  errandId: string;
  from: ErrandState;
  event: ErrandEvent;
  to: ErrandState;
  /** The webhook event id, tool call or user action that caused it. */
  cause: string;
}

export type MoneyKind =
  | 'authorize'
  | 'capture_deposit'
  | 'payout_deposit'
  | 'capture_balance'
  | 'payout_balance'
  | 'void'
  | 'refund'
  | 'reauthorize';

export interface MoneyStep {
  requestId: string;
  errandId: string;
  kind: MoneyKind;
  amount: Money;
  status: 'sent' | 'confirmed' | 'failed';
  paypalId?: string;
}
