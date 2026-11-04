import { toPayPal, type Money } from '@legwork/core';
import type { PayPalClient } from './client';

export interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

export interface PayPalAmount {
  currency_code: string;
  value: string;
}

export interface Authorization {
  id: string;
  status: string;
  amount?: PayPalAmount;
  expiration_time?: string;
}

export interface Capture {
  id: string;
  status: string;
  amount?: PayPalAmount;
  final_capture?: boolean;
}

export interface Order {
  id: string;
  status: string;
  intent?: string;
  links?: PayPalLink[];
  payment_source?: {
    paypal?: {
      email_address?: string;
      attributes?: { vault?: { id?: string; status?: string; customer?: { id?: string } } };
    };
  };
  purchase_units?: Array<{
    reference_id?: string;
    payments?: { authorizations?: Authorization[]; captures?: Capture[] };
  }>;
}

export interface HoldOrderInput {
  /** The buyer's maximum for this errand. */
  amount: Money;
  /** Our errand id, echoed back by PayPal on the purchase unit. */
  referenceId: string;
  /** Shown to the buyer in PayPal. */
  description: string;
  returnUrl: string;
  cancelUrl: string;
  /** Save the buyer's PayPal for later holds (vault with purchase). */
  savePayPal: boolean;
  brandName?: string;
}

/**
 * Step 1 of an errand: an AUTHORIZE order for the buyer's maximum. The buyer
 * approves it in PayPal (JS SDK v6 session or the approve link), then the
 * server calls authorizeOrder.
 *
 * custom_id carries the errand id onto the authorization and captures, so a
 * webhook can be routed to its errand even if it arrives before our own call
 * returns.
 */
export function createHoldOrder(client: PayPalClient, input: HoldOrderInput, requestId: string): Promise<Order> {
  return client.request<Order>('POST', '/v2/checkout/orders', {
    requestId,
    prefer: 'return=representation',
    body: {
      intent: 'AUTHORIZE',
      purchase_units: [
        {
          reference_id: input.referenceId,
          custom_id: input.referenceId,
          description: input.description.slice(0, 127),
          amount: toPayPal(input.amount),
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: input.brandName ?? 'Legwork',
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            return_url: input.returnUrl,
            cancel_url: input.cancelUrl,
          },
          ...(input.savePayPal
            ? { attributes: { vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT', customer_type: 'CONSUMER' } } }
            : {}),
        },
      },
    },
  });
}

/** After the buyer approves: turns the approved order into an authorization (the hold). */
export function authorizeOrder(client: PayPalClient, orderId: string, requestId: string): Promise<Order> {
  return client.request<Order>('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {
    requestId,
    prefer: 'return=representation',
  });
}

export interface VaultedHoldInput {
  vaultId: string;
  amount: Money;
  referenceId: string;
  description: string;
}

/**
 * A hold from the buyer's saved PayPal, with no buyer present: used the day
 * before a pickup that was agreed days ahead. PayPal creates and authorizes
 * the order in one call.
 */
export function createVaultedHold(client: PayPalClient, input: VaultedHoldInput, requestId: string): Promise<Order> {
  return client.request<Order>('POST', '/v2/checkout/orders', {
    requestId,
    prefer: 'return=representation',
    body: {
      intent: 'AUTHORIZE',
      purchase_units: [
        {
          reference_id: input.referenceId,
          custom_id: input.referenceId,
          description: input.description.slice(0, 127),
          amount: toPayPal(input.amount),
        },
      ],
      payment_source: { paypal: { vault_id: input.vaultId } },
    },
  });
}

export function getOrder(client: PayPalClient, orderId: string): Promise<Order> {
  return client.request<Order>('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
}

/** The link the buyer opens to approve (rel "payer-action" when a payment source is given, "approve" otherwise). */
export function approveLink(order: Order): string | undefined {
  return order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
}

export function authorizationOf(order: Order): Authorization | undefined {
  return order.purchase_units?.[0]?.payments?.authorizations?.[0];
}

export function vaultIdOf(order: Order): string | undefined {
  return order.payment_source?.paypal?.attributes?.vault?.id;
}
