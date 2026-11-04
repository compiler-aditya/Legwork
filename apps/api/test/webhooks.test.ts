import { describe, expect, it, vi } from 'vitest';
import type { WebhookEvent } from '@legwork/paypal';
import { MemoryEventStore } from '../src/events';
import { buildServer } from '../src/server';

const rawBody = '{"id":"WH-1",  "event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"CAP1"}}';

function setup(verified: boolean | Error = true) {
  const received: WebhookEvent[] = [];
  const seenBodies: string[] = [];
  const app = buildServer({
    verifyPayPal: async (_headers, body) => {
      seenBodies.push(body);
      if (verified instanceof Error) throw verified;
      return verified;
    },
    events: new MemoryEventStore(),
    onPayPalEvent: async (event) => {
      received.push(event);
    },
  });
  const post = () =>
    app.inject({ method: 'POST', url: '/webhooks/paypal', payload: rawBody, headers: { 'content-type': 'application/json' } });
  return { app, received, seenBodies, post };
}

describe('POST /webhooks/paypal', () => {
  it('verifies the raw body, answers 200 and handles the event once', async () => {
    const { received, seenBodies, post } = setup(true);
    const first = await post();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true, duplicate: false });
    expect(seenBodies[0]).toBe(rawBody);
    await vi.waitFor(() => expect(received).toHaveLength(1));

    const again = await post();
    expect(again.json()).toEqual({ ok: true, duplicate: true });
    await new Promise((r) => setImmediate(r));
    expect(received).toHaveLength(1);
  });

  it('rejects a delivery whose signature fails', async () => {
    const { received, post } = setup(false);
    const res = await post();
    expect(res.statusCode).toBe(400);
    expect(received).toHaveLength(0);
  });

  it('answers 503 when the check itself cannot run, so PayPal retries', async () => {
    const { post } = setup(new Error('PayPal down'));
    expect((await post()).statusCode).toBe(503);
  });

  it('serves a health check', async () => {
    const { app } = setup(true);
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ ok: true });
  });
});
