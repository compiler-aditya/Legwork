import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

describe('createApp', () => {
  it('starts with nothing configured and says what is off', async () => {
    const { app, status } = await createApp({ env: {}, logger: false });
    const off = { storage: 'memory', paypal: { client: false, webhook: false, env: 'sandbox' }, voice: false, calls: { enabled: false, allowlisted: 0 }, errands: false, texts: false, agents: false };
    expect(status).toEqual({ ...off, migrationsApplied: [] });
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ ok: true, ...off });
    expect((await app.inject({ method: 'POST', url: '/errands', payload: {} })).statusCode).toBe(404);
    // PayPal keeps retrying (5xx) until it is configured, so no delivery is lost.
    const res = await app.inject({ method: 'POST', url: '/webhooks/paypal', payload: '{"id":"WH-1","event_type":"X","resource":{}}', headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(503);
    expect((await app.inject({ method: 'POST', url: '/voice/tools/confirm-order', payload: {} })).statusCode).toBe(404);
  });

  it('switches on what the environment provides, and reports the deployed commit', async () => {
    const { app, status } = await createApp({
      env: { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: 'WH', ELEVENLABS_WEBHOOK_SECRET: 'whsec', CALL_TOKEN_SECRET: 'x'.repeat(32), VERCEL_GIT_COMMIT_SHA: 'abcdef123456' },
      logger: false,
    });
    expect(status).toMatchObject({ paypal: { client: true, webhook: true }, voice: true });
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({ commit: 'abcdef1', voice: true });
    // Unsigned deliveries are refused without calling PayPal.
    const res = await app.inject({ method: 'POST', url: '/webhooks/paypal', payload: '{"id":"WH-1","event_type":"X","resource":{}}', headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/voice/tools/confirm-order', payload: {} })).statusCode).toBe(401);
  });
});
