import type { CaptureInput, CreatePayoutInput, HoldOrderInput, Order, WebhookEvent } from '@legwork/paypal';
import type { Money } from '@legwork/core';
import { toPayPal } from '@legwork/core';
import type { PaymentsPort } from './ports';

export interface Call {
  method: string;
  requestId?: string;
  args: unknown;
}

/** A stand-in for PayPal that records every call and hands out predictable ids. */
export class FakePayments implements PaymentsPort {
  readonly calls: Call[] = [];
  private n = 0;
  /** Runs inside captureAuthorization, to simulate a webhook racing the call. */
  onCapture?: (id: string, input: CaptureInput) => void;

  private id(prefix: string) {
    this.n += 1;
    return `${prefix}-${this.n}`;
  }

  async createHoldOrder(input: HoldOrderInput, requestId: string): Promise<Order> {
    this.calls.push({ method: 'createHoldOrder', requestId, args: input });
    const id = this.id('ORDER');
    return { id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] };
  }
  async authorizeOrder(orderId: string, requestId: string): Promise<Order> {
    this.calls.push({ method: 'authorizeOrder', requestId, args: { orderId } });
    return { id: orderId, status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: 'AUTH-1', status: 'CREATED' }] } }] };
  }
  async createVaultedHold(): Promise<Order> {
    throw new Error('not used');
  }
  async captureAuthorization(authorizationId: string, input: CaptureInput, requestId: string) {
    this.calls.push({ method: 'captureAuthorization', requestId, args: { authorizationId, ...input } });
    const id = this.id('CAP');
    this.onCapture?.(id, input);
    return { id, status: 'COMPLETED' };
  }
  async voidAuthorization(authorizationId: string, requestId: string) {
    this.calls.push({ method: 'voidAuthorization', requestId, args: { authorizationId } });
  }
  async refundCapture(captureId: string, input: { amount?: Money }, requestId: string) {
    this.calls.push({ method: 'refundCapture', requestId, args: { captureId, ...input } });
    return { id: this.id('REF'), status: 'COMPLETED' };
  }
  async createPayout(input: CreatePayoutInput, requestId: string) {
    this.calls.push({ method: 'createPayout', requestId, args: input });
    return { batch_header: { payout_batch_id: this.id('BATCH'), batch_status: 'PENDING' } };
  }
  async cancelPayoutItem(payoutItemId: string) {
    this.calls.push({ method: 'cancelPayoutItem', args: { payoutItemId } });
    return { payout_item_id: payoutItemId, transaction_status: 'RETURNED' };
  }

  callsTo(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

let eventSeq = 0;
const event = (event_type: string, resource: Record<string, unknown>): WebhookEvent => ({ id: `WH-${++eventSeq}`, event_type, resource });

export const webhooks = {
  authorizationCreated: (authId: string, errandId: string, amount: Money) =>
    event('PAYMENT.AUTHORIZATION.CREATED', { id: authId, status: 'CREATED', custom_id: errandId, amount: toPayPal(amount) }),
  authorizationVoided: (authId: string, errandId: string) => event('PAYMENT.AUTHORIZATION.VOIDED', { id: authId, status: 'VOIDED', custom_id: errandId }),
  captureCompleted: (captureId: string, invoiceId: string) => event('PAYMENT.CAPTURE.COMPLETED', { id: captureId, status: 'COMPLETED', invoice_id: invoiceId }),
  captureDenied: (captureId: string, invoiceId: string) => event('PAYMENT.CAPTURE.DENIED', { id: captureId, status: 'DECLINED', invoice_id: invoiceId }),
  payoutItem: (status: string, itemId: string, senderItemId: string) =>
    event(`PAYMENT.PAYOUTS-ITEM.${status}`, { payout_item_id: itemId, transaction_status: status, payout_item: { sender_item_id: senderItemId } }),
};
