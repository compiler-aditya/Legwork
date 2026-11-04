import { toPayPal, type Money } from '@legwork/core';
import type { PayPalClient } from './client';
import type { Authorization, Capture } from './orders';

export interface CaptureInput {
  amount: Money;
  /** false for the deposit (more captures follow); true for the balance, which releases the rest of the hold. */
  finalCapture: boolean;
  invoiceId?: string;
  noteToPayer?: string;
}

/**
 * Captures part or all of a hold. Callers must check the amount with
 * assertCaptureAllowed from @legwork/core first; PayPal alone would allow up
 * to 115% of the authorization.
 */
export function captureAuthorization(
  client: PayPalClient,
  authorizationId: string,
  input: CaptureInput,
  requestId: string,
): Promise<Capture> {
  return client.request<Capture>('POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`, {
    requestId,
    prefer: 'return=representation',
    body: {
      amount: toPayPal(input.amount),
      final_capture: input.finalCapture,
      ...(input.invoiceId ? { invoice_id: input.invoiceId } : {}),
      ...(input.noteToPayer ? { note_to_payer: input.noteToPayer.slice(0, 255) } : {}),
    },
  });
}

/** Releases a hold that was never captured (no deal, or the shop cancelled before the deposit). */
export async function voidAuthorization(client: PayPalClient, authorizationId: string, requestId: string): Promise<void> {
  await client.request<unknown>('POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`, {
    requestId,
  });
}

/**
 * Renews a hold after its 3-day honor period (allowed on days 4 to 29). PayPal
 * returns a new authorization id; later captures must use it.
 */
export function reauthorize(
  client: PayPalClient,
  authorizationId: string,
  amount: Money | undefined,
  requestId: string,
): Promise<Authorization> {
  return client.request<Authorization>(
    'POST',
    `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/reauthorize`,
    { requestId, prefer: 'return=representation', body: amount ? { amount: toPayPal(amount) } : {} },
  );
}

export function getAuthorization(client: PayPalClient, authorizationId: string): Promise<Authorization> {
  return client.request<Authorization>('GET', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`);
}

export interface Refund {
  id: string;
  status: string;
  amount?: { currency_code: string; value: string };
}

/** Refunds a capture: the whole of it when amount is omitted. */
export function refundCapture(
  client: PayPalClient,
  captureId: string,
  input: { amount?: Money; noteToPayer?: string },
  requestId: string,
): Promise<Refund> {
  return client.request<Refund>('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    requestId,
    prefer: 'return=representation',
    body: {
      ...(input.amount ? { amount: toPayPal(input.amount) } : {}),
      ...(input.noteToPayer ? { note_to_payer: input.noteToPayer.slice(0, 255) } : {}),
    },
  });
}
