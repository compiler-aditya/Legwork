import { describe, expect, it, vi } from 'vitest';
import { FakePayments, webhooks } from '@legwork/orchestrator/testing';
import type { Caller } from '@legwork/outreach';
import { signTwilio } from '@legwork/messaging';
import { CALL_TOKEN_HEADER, signElevenLabsBody, type CallVariables } from '@legwork/voice';
import type { MessagesApi } from '@legwork/agents';
import { createApp } from '../src/app';

const ADMIN = 'admin-token-for-tests';
const WEBHOOK_SECRET = 'whsec_elevenlabs_test';
const TWILIO_TOKEN = 'twilio-auth-token';
const BUYER = '+14155559999';
const SHOPS = [
  { businessId: 'biz_hartley', name: 'Hartley Hardware', phone: '+14155550101' },
  { businessId: 'biz_corner', name: 'Corner Plumbing Supply', phone: '+14155550102' },
  { businessId: 'biz_mission', name: 'Mission Ace', phone: '+14155550103' },
];

async function setup() {
  const calls: Array<{ to: string; variables: CallVariables; conversationId: string }> = [];
  const caller: Caller = {
    place: async (input) => {
      const conversationId = `conv_${calls.length + 1}`;
      calls.push({ ...input, conversationId });
      return { conversationId };
    },
  };
  const payments = new FakePayments();
  const texts: Array<{ to: string; body: string }> = [];
  const { app, status } = await createApp({
    env: {
      LEGWORK_ADMIN_TOKEN: ADMIN,
      CALL_TOKEN_SECRET: 'call-token-secret-of-at-least-32-chars!',
      ELEVENLABS_WEBHOOK_SECRET: WEBHOOK_SECRET,
      CALL_ALLOWLIST: SHOPS.map((s) => s.phone).join(','),
      PUBLIC_API_URL: 'https://api.legwork.test',
      TWILIO_ACCOUNT_SID: 'AC_test',
      TWILIO_AUTH_TOKEN: TWILIO_TOKEN,
      TWILIO_FROM_NUMBER: '+14155550000',
    },
    caller,
    sms: { send: async (to, body) => texts.push({ to, body }) },
    // Claude, faked: reads the confirmation call as $32 for one cartridge.
    anthropic: {
      create: async () => ({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_details: null, usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: JSON.stringify({
          agreed: true,
          item: { value: 'Moen 1222 cartridge', line: 1, quote: 'Moen 1222 cartridge' },
          quantity: { value: 1, line: 1, quote: 'one' },
          total: { value: '32.00', line: 1, quote: '$32' },
          ready_at: { value: 'after 3', line: 1, quote: 'after 3' },
          notes: '',
        }) }],
      }),
    } as unknown as MessagesApi,
    paypal: { payments, verify: async () => true },
    logger: false,
  });
  const auth = { authorization: `Bearer ${ADMIN}` };
  const paypalWebhook = (event: unknown) =>
    app.inject({ method: 'POST', url: '/webhooks/paypal', payload: JSON.stringify(event), headers: { 'content-type': 'application/json' } });
  const tool = (path: string, call: (typeof calls)[number], body: unknown) =>
    app.inject({ method: 'POST', url: `/voice/tools/${path}`, payload: body as Record<string, unknown>, headers: { [CALL_TOKEN_HEADER]: call.variables.call_token } });
  const callEnded = (call: (typeof calls)[number], lines: Array<{ role: 'agent' | 'user'; message: string }> = []) => {
    const body = JSON.stringify({
      type: 'post_call_transcription',
      data: {
        agent_id: 'agent_1',
        conversation_id: call.conversationId,
        status: 'done',
        transcript: lines.map((l, i) => ({ ...l, time_in_call_secs: i * 5 })),
        conversation_initiation_client_data: { dynamic_variables: { errand_id: call.variables.errand_id, outreach_id: call.variables.outreach_id, round: call.variables.round } },
      },
    });
    return app.inject({ method: 'POST', url: '/webhooks/elevenlabs', payload: body, headers: { 'content-type': 'application/json', 'elevenlabs-signature': signElevenLabsBody(body, WEBHOOK_SECRET) } });
  };
  const view = async (id: string) => (await app.inject({ method: 'GET', url: `/errands/${id}`, headers: auth })).json();
  /** A text to the Legwork number, signed the way Twilio signs it. */
  const textIn = (from: string, body: string, sid: string) => {
    const params = { From: from, To: '+14155550000', Body: body, MessageSid: sid };
    const signature = signTwilio(TWILIO_TOKEN, 'https://api.legwork.test/webhooks/twilio/sms', params);
    return app.inject({ method: 'POST', url: '/webhooks/twilio/sms', payload: new URLSearchParams(params).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature } });
  };
  return { app, status, calls, payments, texts, auth, paypalWebhook, tool, callEnded, view, textIn };
}

describe('the hero errand over HTTP', () => {
  it('goes from a request to a settled errand, driven only by PayPal, the agent tools, post-call webhooks and texts', async () => {
    const t = await setup();
    expect(t.status).toMatchObject({ errands: true, voice: true, texts: true, agents: true, calls: { enabled: true, allowlisted: 3 } });

    // 1. The buyer asks; the API returns PayPal's approve link for a $40 hold.
    const created = await t.app.inject({
      method: 'POST',
      url: '/errands',
      headers: t.auth,
      payload: {
        userId: 'usr_sam',
        userName: 'Sam',
        request: { kind: 'item', text: 'A Moen 1222 cartridge for my shower, today' },
        budgetMaxCents: 4000,
        plan: { item: 'a Moen 1222 shower cartridge', quantity: 1, pickupWindow: 'today after 3pm', buyerFirstName: 'Sam', buyerPhone: BUYER, benchmark: { priceCents: 3100, source: 'Channel3' }, shops: SHOPS },
      },
    });
    expect(created.statusCode).toBe(201);
    const { errandId, approveUrl } = created.json() as { errandId: string; approveUrl: string };
    expect(approveUrl).toContain('checkoutnow');
    expect(t.payments.callsTo('createHoldOrder')[0]!.args).toMatchObject({ returnUrl: `https://api.legwork.test/paypal/return?errand=${errandId}` });

    // 2. PayPal sends the buyer back; the hold is authorized; PayPal's webhook starts round 1.
    const back = await t.app.inject({ method: 'GET', url: `/paypal/return?errand=${errandId}&token=ORDER-1&PayerID=P1` });
    expect(back.statusCode).toBe(200);
    expect(back.body).toContain('calling the shops');
    expect((await t.app.inject({ method: 'GET', url: `/paypal/return?errand=${errandId}&token=ORDER-999` })).statusCode).toBe(404);
    await t.paypalWebhook(webhooks.authorizationCreated('AUTH-1', errandId, { cents: 4000, currency: 'USD' }));
    await vi.waitFor(() => expect(t.calls).toHaveLength(3));

    // 3. Three quote calls: the agent records quotes, then each call ends.
    const [hartley, corner, mission] = t.calls as [(typeof t.calls)[number], (typeof t.calls)[number], (typeof t.calls)[number]];
    await t.tool('record-quote', hartley, { in_stock: true, price: '34.00', ready_at: 'after 3' });
    await t.tool('record-quote', corner, { in_stock: true, price: '38.50', ready_at: 'tomorrow' });
    await t.tool('record-quote', mission, { in_stock: false, price: '', ready_at: '' });
    for (const call of [hartley, corner, mission]) await t.callEnded(call, [{ role: 'user', message: 'Hello?' }]);

    // 4. Round 2: Hartley is called back with a counter-offer and confirms at $32.
    await vi.waitFor(() => expect(t.calls).toHaveLength(4));
    const callback = t.calls[3]!;
    expect(callback).toMatchObject({ to: SHOPS[0]!.phone, variables: { round: '2', quoted_price: '34.00', offer_price: '31.00' } });
    const confirmed = await t.tool('confirm-order', callback, { item: 'Moen 1222 cartridge', quantity: 1, total: '32.00', ready_at: 'after 3', payout_method: 'this_phone_venmo', payout_receiver: '' });
    expect(confirmed.json()).toMatchObject({ ok: true });
    await t.callEnded(callback, [
      { role: 'agent', message: 'Could you do thirty-one for the cartridge?' },
      { role: 'user', message: 'I can do one Moen 1222 cartridge for $32, ready after 3.' },
    ]);

    // 5. The deposit is captured, and paid to the shop once PayPal confirms the capture.
    await vi.waitFor(() => expect(t.payments.callsTo('captureAuthorization')).toHaveLength(1));
    expect(t.payments.callsTo('captureAuthorization')[0]!.args).toMatchObject({ finalCapture: false, amount: { cents: 900 } }); // 30% of $32, in whole dollars
    await t.paypalWebhook(webhooks.captureCompleted('CAP-2', `${errandId}-deposit-0`));
    await vi.waitFor(() => expect(t.payments.callsTo('createPayout')).toHaveLength(1));
    expect(t.payments.callsTo('createPayout')[0]!.args).toMatchObject({ items: [{ recipientType: 'PHONE', receiver: SHOPS[0]!.phone, wallet: 'VENMO' }] });

    // 6. Texts: the shop gets the order, the buyer gets the code.
    await vi.waitFor(() => expect(t.texts.map((x) => x.to)).toEqual([SHOPS[0]!.phone, BUYER]));
    const code = /pickup code is (\d{4})/.exec(t.texts[1]!.body)![1]!;
    expect(t.texts[0]!.body).not.toContain(code);

    // 7. At the counter the buyer gives the code; the shop texts it back. A forged text is refused.
    expect((await t.app.inject({ method: 'POST', url: '/webhooks/twilio/sms', payload: `From=${encodeURIComponent(SHOPS[0]!.phone)}&Body=${code}`, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'forged' } })).statusCode).toBe(403);
    const wrong = await t.textIn(SHOPS[0]!.phone, '0000', 'SM1');
    expect(wrong.body).toContain('that code does not match');
    const right = await t.textIn(SHOPS[0]!.phone, `Customer here, code ${code}`, 'SM2');
    expect(right.headers['content-type']).toMatch(/text\/xml/);
    expect(right.body).toContain('code confirmed, thank you. $23.00 is on its way');
    expect(t.payments.callsTo('captureAuthorization')[1]!.args).toMatchObject({ finalCapture: true, amount: { cents: 2300 } });

    // 8. PayPal confirms the balance: the shop is paid and the buyer gets the receipt.
    await t.paypalWebhook(webhooks.captureCompleted('CAP-5', `${errandId}-balance-0`));
    await vi.waitFor(() => expect(t.payments.callsTo('createPayout')).toHaveLength(2));
    await vi.waitFor(() => expect(t.texts.at(-1)).toEqual({ to: BUYER, body: 'Legwork: done. You paid $32.00 to Hartley Hardware through PayPal; the other $8.00 of your hold is released.' }));

    const final = await t.view(errandId);
    expect(final.errand).toMatchObject({ state: 'settled', contract: { businessId: 'biz_hartley', total: { cents: 3200 }, deposit: { cents: 900 } } });
    expect(final.pickups).toMatchObject([{ status: 'confirmed', wrongAttempts: 1, shopPhone: SHOPS[0]!.phone }]);
    // Claude's reading of the confirmation call matches what the agent recorded.
    expect(final.outreach.rows[3].review).toMatchObject({ agreed: true, mismatches: [], unverified: [], terms: { totalCents: { value: 3200, line: 1, at: '0:05' } } });
    expect(final.outreach.rows.map((r: { businessId: string; round: number; result: string }) => `${r.round}:${r.businessId}:${r.result}`)).toEqual([
      '1:biz_hartley:quoted',
      '1:biz_corner:quoted',
      '1:biz_mission:unavailable',
      '2:biz_hartley:confirmed',
    ]);
  });

  it('keeps errands behind the admin token', async () => {
    const t = await setup();
    expect((await t.app.inject({ method: 'POST', url: '/errands', payload: {} })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/errands', headers: { authorization: 'Bearer wrong' }, payload: {} })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/errands', headers: t.auth, payload: { userId: 'u' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/errands/err_nope', headers: t.auth })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: '/internal/tick', headers: t.auth })).json()).toEqual({ ok: true, done: [] });
  });
});
