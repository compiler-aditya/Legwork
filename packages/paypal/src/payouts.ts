import { toPayoutAmount, type Money } from '@legwork/core';
import type { PayPalClient } from './client';

/** USER_HANDLE is a Venmo handle (documented on the Payouts to Venmo page; newer than the published OpenAPI spec). */
export type RecipientType = 'EMAIL' | 'PHONE' | 'PAYPAL_ID' | 'USER_HANDLE';

/**
 * The OpenAPI spec lists recipient_wallet values "PAYPAL" and "VENMO"; the
 * Payouts to Venmo guide's example writes "Venmo". The day-one checks try
 * both and report which the sandbox accepts.
 */
export type RecipientWallet = 'PAYPAL' | 'VENMO' | 'Venmo';

export interface PayoutItemInput {
  recipientType: RecipientType;
  receiver: string;
  amount: Money;
  /** Stable per errand and step (see senderItemIdFor). */
  senderItemId: string;
  note?: string;
  wallet?: RecipientWallet;
}

export interface CreatePayoutInput {
  senderBatchId: string;
  emailSubject: string;
  emailMessage?: string;
  items: PayoutItemInput[];
}

export interface PayoutBatchHeader {
  payout_batch_id: string;
  batch_status: string;
  sender_batch_header?: { sender_batch_id?: string };
}

export interface PayoutItem {
  payout_item_id: string;
  transaction_status?: string;
  transaction_id?: string;
  payout_item?: { receiver?: string; sender_item_id?: string; recipient_type?: string; recipient_wallet?: string };
  errors?: { name?: string; message?: string };
}

export interface PayoutBatch {
  batch_header: PayoutBatchHeader;
  items?: PayoutItem[];
}

/** Pays one or more recipients. Recipients without an account get a claim link; unclaimed money returns after 30 days. */
export function createPayout(client: PayPalClient, input: CreatePayoutInput, requestId: string): Promise<{ batch_header: PayoutBatchHeader }> {
  return client.request('POST', '/v1/payments/payouts', {
    requestId,
    body: {
      sender_batch_header: {
        sender_batch_id: input.senderBatchId,
        email_subject: input.emailSubject,
        ...(input.emailMessage ? { email_message: input.emailMessage } : {}),
      },
      items: input.items.map((item) => ({
        recipient_type: item.recipientType,
        receiver: item.receiver,
        amount: toPayoutAmount(item.amount),
        sender_item_id: item.senderItemId,
        ...(item.note ? { note: item.note } : {}),
        ...(item.wallet ? { recipient_wallet: item.wallet } : {}),
      })),
    },
  });
}

export function getPayoutBatch(client: PayPalClient, payoutBatchId: string): Promise<PayoutBatch> {
  return client.request<PayoutBatch>('GET', `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`);
}

export function getPayoutItem(client: PayPalClient, payoutItemId: string): Promise<PayoutItem> {
  return client.request<PayoutItem>('GET', `/v1/payments/payouts-item/${encodeURIComponent(payoutItemId)}`);
}

/** Only works while the item is UNCLAIMED; the money returns to Legwork's balance. */
export function cancelPayoutItem(client: PayPalClient, payoutItemId: string): Promise<PayoutItem> {
  return client.request<PayoutItem>('POST', `/v1/payments/payouts-item/${encodeURIComponent(payoutItemId)}/cancel`);
}

/** Batch statuses that will not change any more. */
export const FINAL_BATCH_STATUSES = new Set(['SUCCESS', 'DENIED', 'CANCELED']);
