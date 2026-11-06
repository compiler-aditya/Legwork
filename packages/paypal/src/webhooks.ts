import type { PayPalClient } from './client';

/** The five headers PayPal signs every webhook delivery with. */
export const SIGNATURE_HEADERS = {
  authAlgo: 'paypal-auth-algo',
  certUrl: 'paypal-cert-url',
  transmissionId: 'paypal-transmission-id',
  transmissionSig: 'paypal-transmission-sig',
  transmissionTime: 'paypal-transmission-time',
} as const;

export type HeaderBag = Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Asks PayPal whether a delivery is genuine. The event goes back exactly as
 * received: re-serialising it changes the bytes the signature covers, so the
 * request body is assembled around the raw text instead of JSON.stringify.
 */
export async function verifyWebhookSignature(
  client: PayPalClient,
  args: { headers: HeaderBag; rawBody: string; webhookId: string },
): Promise<boolean> {
  const values = {
    auth_algo: header(args.headers, SIGNATURE_HEADERS.authAlgo),
    cert_url: header(args.headers, SIGNATURE_HEADERS.certUrl),
    transmission_id: header(args.headers, SIGNATURE_HEADERS.transmissionId),
    transmission_sig: header(args.headers, SIGNATURE_HEADERS.transmissionSig),
    transmission_time: header(args.headers, SIGNATURE_HEADERS.transmissionTime),
  };
  if (Object.values(values).some((v) => !v) || !args.webhookId) return false;
  if (!looksLikeJsonObject(args.rawBody)) return false;

  const fields = Object.entries({ ...values, webhook_id: args.webhookId })
    .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
    .join(',');
  const rawBody = `{${fields},"webhook_event":${args.rawBody}}`;

  const res = await client.request<{ verification_status?: string }>('POST', '/v1/notifications/verify-webhook-signature', {
    rawBody,
  });
  return res?.verification_status === 'SUCCESS';
}

function looksLikeJsonObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

export interface WebhookEvent<R = Record<string, unknown>> {
  id: string;
  event_type: string;
  resource_type?: string;
  create_time?: string;
  resource: R;
}

export function parseWebhookEvent(rawBody: string): WebhookEvent {
  const event = JSON.parse(rawBody) as Partial<WebhookEvent>;
  if (!event.id || !event.event_type || typeof event.resource !== 'object' || event.resource === null) {
    throw new Error('Not a PayPal webhook event');
  }
  return event as WebhookEvent;
}

/** The PayPal events Legwork subscribes to, each checked against PayPal's event-name reference. */
export const SUBSCRIBED_EVENTS = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.AUTHORIZATION.CREATED',
  'PAYMENT.AUTHORIZATION.VOIDED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.PAYOUTSBATCH.SUCCESS',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
  'PAYMENT.PAYOUTS-ITEM.CANCELED',
  'PAYMENT.PAYOUTS-ITEM.RETURNED',
  'PAYMENT.PAYOUTS-ITEM.FAILED',
  'PAYMENT.PAYOUTS-ITEM.BLOCKED',
  'VAULT.PAYMENT-TOKEN.CREATED',
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.RESOLVED',
] as const;
