import { describe, expect, it } from 'vitest';
import { usd } from '@legwork/core';
import {
  PayPalApiError,
  PayPalClient,
  approveLink,
  authorizationOf,
  captureAuthorization,
  cancelPayoutItem,
  createHoldOrder,
  createPayout,
  createVaultedHold,
  parseWebhookEvent,
  vaultIdOf,
  verifyWebhookSignature,
  voidAuthorization,
} from '../src';
import { fakeFetch, json } from './fake-fetch';

const noSleep = async () => {};

function client(responders: Parameters<typeof fakeFetch>[0], extra: { now?: () => number; tokenTtl?: number } = {}) {
  const fake = fakeFetch(responders, extra.tokenTtl);
  const pp = new PayPalClient({ clientId: 'id', clientSecret: 'secret', fetch: fake.fetch, sleep: noSleep, now: extra.now });
  return { pp, ...fake };
}

describe('PayPalClient', () => {
  it('uses the sandbox by default and caches the token', async () => {
    const { pp, requests, tokenCount } = client([() => json(200, { id: 'O1' }), () => json(200, { id: 'O2' })]);
    await pp.request('GET', '/v2/checkout/orders/O1');
    await pp.request('GET', '/v2/checkout/orders/O2');
    expect(tokenCount()).toBe(1);
    expect(requests[0]?.url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders/O1');
    expect(requests[0]?.headers.Authorization).toBe('Bearer token-1');
  });

  it('fetches a new token after expiry and after a 401', async () => {
    let t = 0;
    const { pp, tokenCount } = client(
      [() => json(200, {}), () => json(401, { name: 'AUTHENTICATION_FAILURE' }), () => json(200, {})],
      { now: () => t, tokenTtl: 120 },
    );
    await pp.request('GET', '/a');
    t = 61_000; // past expires_in minus the 60 s margin
    await pp.request('GET', '/b'); // new token, then 401, then a forced refresh
    expect(tokenCount()).toBe(3);
  });

  it('retries a 503 when the call carries a request id', async () => {
    const { pp, requests } = client([
      () => json(503, { name: 'SERVICE_UNAVAILABLE' }, { 'Retry-After': '0' }),
      () => json(201, { id: 'CAP1', status: 'COMPLETED' }),
    ]);
    const capture = await captureAuthorization(pp, 'AUTH1', { amount: usd(1000), finalCapture: false }, 'lw-e1-capture-deposit');
    expect(capture.id).toBe('CAP1');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers['PayPal-Request-Id']).toBe('lw-e1-capture-deposit');
  });

  it('never retries a write without a request id', async () => {
    const { pp, requests } = client([() => json(503, { name: 'SERVICE_UNAVAILABLE' })]);
    await expect(cancelPayoutItem(pp, 'ITEM1')).rejects.toBeInstanceOf(PayPalApiError);
    expect(requests).toHaveLength(1);
  });

  it('turns PayPal errors into typed errors with the debug id', async () => {
    const { pp } = client([
      () =>
        json(422, {
          name: 'UNPROCESSABLE_ENTITY',
          message: 'The requested action could not be performed.',
          debug_id: 'abc123',
          details: [{ issue: 'INSTRUMENT_DECLINED', description: 'The instrument presented was declined.' }],
        }),
    ]);
    const err = await createHoldOrder(
      pp,
      { amount: usd(4000), referenceId: 'e1', description: 'x', returnUrl: 'https://a/r', cancelUrl: 'https://a/c', savePayPal: false },
      'lw-e1-hold',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect((err as PayPalApiError).hasIssue('INSTRUMENT_DECLINED')).toBe(true);
    expect((err as PayPalApiError).debugId).toBe('abc123');
  });
});

describe('orders and payments', () => {
  it('creates the budget hold as an AUTHORIZE order that saves PayPal', async () => {
    const { pp, requests } = client([
      () =>
        json(200, {
          id: 'ORDER1',
          status: 'PAYER_ACTION_REQUIRED',
          links: [{ rel: 'self', href: 'https://x/self' }, { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1' }],
        }),
    ]);
    const order = await createHoldOrder(
      pp,
      {
        amount: usd(4000),
        referenceId: 'err_1',
        description: 'Legwork: Moen 1222 cartridge, up to $40',
        returnUrl: 'https://legwork.test/return',
        cancelUrl: 'https://legwork.test/cancel',
        savePayPal: true,
      },
      'lw-err_1-hold',
    );
    const body = JSON.parse(requests[0]?.body ?? '{}');
    expect(body.intent).toBe('AUTHORIZE');
    expect(body.purchase_units[0]).toMatchObject({ reference_id: 'err_1', amount: { currency_code: 'USD', value: '40.00' } });
    expect(body.payment_source.paypal.attributes.vault).toEqual({
      store_in_vault: 'ON_SUCCESS',
      usage_type: 'MERCHANT',
      customer_type: 'CONSUMER',
    });
    expect(body.payment_source.paypal.experience_context.shipping_preference).toBe('NO_SHIPPING');
    expect(requests[0]?.headers.Prefer).toBe('return=representation');
    expect(approveLink(order)).toContain('token=ORDER1');
  });

  it('places a hold from saved PayPal with only the vault id', async () => {
    const { pp, requests } = client([
      () =>
        json(201, {
          id: 'ORDER2',
          status: 'COMPLETED',
          purchase_units: [{ payments: { authorizations: [{ id: 'AUTH2', status: 'CREATED' }] } }],
        }),
    ]);
    const order = await createVaultedHold(pp, { vaultId: 'tok_1', amount: usd(5500), referenceId: 'err_2', description: 'Cake' }, 'lw-err_2-hold');
    const body = JSON.parse(requests[0]?.body ?? '{}');
    expect(body.payment_source).toEqual({ paypal: { vault_id: 'tok_1' } });
    expect(authorizationOf(order)).toEqual({ id: 'AUTH2', status: 'CREATED' });
  });

  it('reads the vault id from an authorized order', () => {
    expect(vaultIdOf({ id: 'O', status: 'COMPLETED', payment_source: { paypal: { attributes: { vault: { id: 'tok_9' } } } } })).toBe('tok_9');
    expect(vaultIdOf({ id: 'O', status: 'COMPLETED' })).toBeUndefined();
  });

  it('captures a deposit without closing the hold, and voids with a request id', async () => {
    const { pp, requests } = client([() => json(201, { id: 'CAP1', status: 'COMPLETED' }), () => new Response(null, { status: 204 })]);
    await captureAuthorization(pp, 'AUTH1', { amount: usd(1000), finalCapture: false, invoiceId: 'err_1-deposit' }, 'lw-err_1-capture-deposit');
    await voidAuthorization(pp, 'AUTH9', 'lw-err_9-void');
    expect(requests[0]?.url).toContain('/v2/payments/authorizations/AUTH1/capture');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      amount: { currency_code: 'USD', value: '10.00' },
      final_capture: false,
      invoice_id: 'err_1-deposit',
    });
    expect(requests[1]?.url).toContain('/v2/payments/authorizations/AUTH9/void');
    expect(requests[1]?.headers['PayPal-Request-Id']).toBe('lw-err_9-void');
  });
});

describe('payouts', () => {
  it('pays a shop by phone on Venmo with a stable sender item id', async () => {
    const { pp, requests } = client([() => json(201, { batch_header: { payout_batch_id: 'B1', batch_status: 'PENDING' } })]);
    await createPayout(
      pp,
      {
        senderBatchId: 'lw-err_1-payout-deposit',
        emailSubject: 'Deposit from Legwork',
        items: [
          { recipientType: 'PHONE', receiver: '+14155550100', amount: usd(1000), senderItemId: 'lw-err_1-payout-deposit', wallet: 'VENMO', note: 'Deposit for order 4821' },
        ],
      },
      'lw-err_1-payout-deposit',
    );
    const body = JSON.parse(requests[0]?.body ?? '{}');
    expect(body.sender_batch_header.sender_batch_id).toBe('lw-err_1-payout-deposit');
    expect(body.items[0]).toEqual({
      recipient_type: 'PHONE',
      receiver: '+14155550100',
      amount: { currency: 'USD', value: '10.00' },
      sender_item_id: 'lw-err_1-payout-deposit',
      note: 'Deposit for order 4821',
      recipient_wallet: 'VENMO',
    });
  });
});

describe('webhook verification', () => {
  const headers = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
    'paypal-transmission-id': 'tx-1',
    'paypal-transmission-sig': 'sig==',
    'paypal-transmission-time': '2026-11-04T20:00:00Z',
  };
  // Odd spacing on purpose: the bytes must reach PayPal untouched.
  const rawBody = '{"id":"WH-1",  "event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"CAP1"}}';

  it('sends the event back byte for byte and accepts SUCCESS', async () => {
    const { pp, requests } = client([() => json(200, { verification_status: 'SUCCESS' })]);
    expect(await verifyWebhookSignature(pp, { headers, rawBody, webhookId: 'WEBHOOK-1' })).toBe(true);
    const sent = requests[0]?.body ?? '';
    expect(sent.endsWith(`"webhook_event":${rawBody}}`)).toBe(true);
    expect(JSON.parse(sent)).toMatchObject({ auth_algo: 'SHA256withRSA', webhook_id: 'WEBHOOK-1', transmission_id: 'tx-1' });
  });

  it('rejects FAILURE, missing headers and non-JSON bodies', async () => {
    const { pp, requests } = client([() => json(200, { verification_status: 'FAILURE' })]);
    expect(await verifyWebhookSignature(pp, { headers, rawBody, webhookId: 'WEBHOOK-1' })).toBe(false);
    const { 'paypal-transmission-sig': _sig, ...missing } = headers;
    expect(await verifyWebhookSignature(pp, { headers: missing, rawBody, webhookId: 'WEBHOOK-1' })).toBe(false);
    expect(await verifyWebhookSignature(pp, { headers, rawBody: 'not json', webhookId: 'WEBHOOK-1' })).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it('parses events and refuses anything that is not one', () => {
    expect(parseWebhookEvent(rawBody).event_type).toBe('PAYMENT.CAPTURE.COMPLETED');
    expect(() => parseWebhookEvent('{"id":"x"}')).toThrow();
  });
});
