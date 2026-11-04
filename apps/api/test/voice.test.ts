import { describe, expect, it, vi } from 'vitest';
import { usd } from '@legwork/core';
import { ErrandMoney, MemoryErrandRepo, type Deal } from '@legwork/orchestrator';
import { FakePayments, webhooks } from '@legwork/orchestrator/testing';
import { CALL_TOKEN_HEADER, mintCallToken, signElevenLabsBody, type CallClaims, type CallReport, type Quote } from '@legwork/voice';
import { MemoryEventStore } from '../src/events';
import { buildServer } from '../src/server';
import type { VoiceDeps } from '../src/voice';

const TOKEN_SECRET = 'call-token-secret-of-at-least-32-chars!';
const WEBHOOK_SECRET = 'whsec_elevenlabs_test';
const ERRAND = 'err_tap1';
const round2 = { errandId: ERRAND, outreachId: 'out_r2_hartley', businessId: 'biz_hartley', round: 2 as const, dialled: '+14155550123' };

function setup(over: Partial<VoiceDeps> = {}) {
  const quotes: Array<{ claims: CallClaims; quote: Quote }> = [];
  const deals: Deal[] = [];
  const reports: CallReport[] = [];
  const afterConfirm = vi.fn(async () => undefined);
  const voice: VoiceDeps = {
    callTokenSecret: TOKEN_SECRET,
    webhookSecret: WEBHOOK_SECRET,
    recordQuote: async (claims, quote) => {
      quotes.push({ claims, quote });
    },
    confirmOrder: async (_claims, deal) => {
      deals.push(deal);
      return { ok: true, contractId: `${ERRAND}-c1`, pickupCode: '4821', deposit: usd(1000) };
    },
    afterConfirm,
    onCallReport: async (report) => {
      reports.push(report);
    },
    ...over,
  };
  const app = buildServer({ verifyPayPal: async () => true, events: new MemoryEventStore(), onPayPalEvent: async () => undefined, voice });
  const tool = (path: string, body: unknown, claims?: Omit<CallClaims, 'exp'>) =>
    app.inject({
      method: 'POST',
      url: `/voice/tools/${path}`,
      payload: body as Record<string, unknown>,
      headers: claims ? { [CALL_TOKEN_HEADER]: mintCallToken(TOKEN_SECRET, claims) } : {},
    });
  return { app, tool, quotes, deals, reports, afterConfirm };
}

const order = { item: 'Moen 1222 cartridge', quantity: 1, total: '34.00', ready_at: 'today after 3', payout_method: 'this_phone_venmo', payout_receiver: '' };

describe('confirm_order', () => {
  it('refuses a call without a valid token', async () => {
    const { tool, deals } = setup();
    expect((await tool('confirm-order', order)).statusCode).toBe(401);
    expect(deals).toHaveLength(0);
  });

  it('will not confirm on a quote call', async () => {
    const { tool, deals } = setup();
    const res = await tool('confirm-order', order, { ...round2, round: 1 });
    expect(res.json()).toMatchObject({ ok: false });
    expect(deals).toHaveLength(0);
  });

  it('hands the deal over and tells the shop about the money, never the pickup code', async () => {
    const { tool, deals, afterConfirm } = setup();
    const res = await tool('confirm-order', order, round2);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; say: string };
    expect(body.ok).toBe(true);
    expect(body.say).toContain('$34.00');
    expect(body.say).toContain('A deposit of $10.00');
    expect(body.say).toContain('the remaining $24.00');
    expect(body.say).toContain('Venmo account on this phone number');
    expect(body.say).not.toContain('4821');
    expect(deals[0]).toMatchObject({ businessId: 'biz_hartley', total: usd(3400), payout: { type: 'PHONE', receiver: '+14155550123' } });
    await vi.waitFor(() => expect(afterConfirm).toHaveBeenCalledTimes(1));
  });

  it('passes on why an order was refused, and asks again for unclear answers', async () => {
    const { tool, afterConfirm } = setup({ confirmOrder: async () => ({ ok: false, reason: 'price is above the $40.00 held for this errand' }) });
    expect((await tool('confirm-order', order, round2)).json()).toEqual({ ok: false, say: "I can't confirm that order: price is above the $40.00 held for this errand." });
    expect((await tool('confirm-order', { ...order, total: 'about thirty' }, round2)).json()).toMatchObject({ ok: false, say: expect.stringContaining('total') });
    expect((await tool('confirm-order', { ...order, payout_method: 'email', payout_receiver: 'nope' }, round2)).json()).toMatchObject({ ok: false, say: expect.stringContaining('spell it again') });
    expect(afterConfirm).not.toHaveBeenCalled();
  });
});

describe('record_quote', () => {
  it('stores the quote in cents against the token\'s outreach', async () => {
    const { tool, quotes } = setup();
    const res = await tool('record-quote', { in_stock: true, price: '31.50', ready_at: 'tomorrow 9am', item_offered: '', notes: 'last one' }, { ...round2, round: 1 });
    expect(res.json()).toMatchObject({ ok: true });
    expect(quotes[0]).toMatchObject({ claims: { outreachId: 'out_r2_hartley' }, quote: { inStock: true, price: usd(3150), readyAt: 'tomorrow 9am', notes: 'last one', declinedAiCalls: false } });
  });
});

describe('POST /webhooks/elevenlabs', () => {
  const body = JSON.stringify({
    type: 'post_call_transcription',
    data: { agent_id: 'a', conversation_id: 'conv_1', status: 'done', transcript: [{ role: 'user', message: 'Hello?', time_in_call_secs: 1 }], conversation_initiation_client_data: { dynamic_variables: { outreach_id: 'out_1' } } },
  });
  const post = (app: ReturnType<typeof setup>['app'], signature: string) =>
    app.inject({ method: 'POST', url: '/webhooks/elevenlabs', payload: body, headers: { 'content-type': 'application/json', 'elevenlabs-signature': signature } });

  it('checks the signature on the raw body and handles each conversation once', async () => {
    const { app, reports } = setup();
    expect((await post(app, signElevenLabsBody(body, 'wrong-secret'))).statusCode).toBe(401);
    const first = await post(app, signElevenLabsBody(body, WEBHOOK_SECRET));
    expect(first.json()).toEqual({ ok: true, duplicate: false });
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect(reports[0]).toMatchObject({ kind: 'transcript', outreachId: 'out_1', lines: [{ speaker: 'shop', text: 'Hello?' }] });
    await new Promise((r) => setImmediate(r));
    expect((await post(app, signElevenLabsBody(body, WEBHOOK_SECRET))).json()).toEqual({ ok: true, duplicate: true });
  });
});

describe('from the phone call to the PayPal deposit', () => {
  it('confirms the deal on the errand and captures the deposit once PayPal has the hold', async () => {
    const payments = new FakePayments();
    const repo = new MemoryErrandRepo();
    const money = new ErrandMoney({ payments, repo, pickupCode: () => '4821' });
    await money.createErrand({ id: ERRAND, userId: 'usr_sam', request: { kind: 'item', text: 'Moen 1222 cartridge' }, budgetMax: usd(4000) });
    await money.advance(ERRAND, 'PLAN_READY', 'planner');
    await money.requestHold(ERRAND, { returnUrl: 'https://r', cancelUrl: 'https://c', savePayPal: true, description: 'cartridge' });
    await money.buyerApproved(ERRAND);
    await money.handlePayPalEvent(webhooks.authorizationCreated('AUTH-1', ERRAND, usd(4000)));
    for (const e of ['QUOTES_STARTED', 'QUOTES_DONE', 'BEST_CHOSEN'] as const) await money.advance(ERRAND, e, 'test');

    const { tool } = setup({
      confirmOrder: (claims, deal) => money.confirmDeal(claims.errandId, deal),
      afterConfirm: async (claims) => {
        await money.payDeposit(claims.errandId);
      },
    });
    const res = await tool('confirm-order', order, round2);
    expect(res.json()).toMatchObject({ ok: true });
    await vi.waitFor(async () => expect((await repo.get(ERRAND))!.state).toBe('deposit_pending'));
    const errand = (await repo.get(ERRAND))!;
    expect(errand.contract).toMatchObject({ businessId: 'biz_hartley', outreachId: 'out_r2_hartley', total: usd(3400), payout: { receiver: '+14155550123', wallet: 'VENMO' } });
    expect(payments.callsTo('captureAuthorization')[0]!.args).toMatchObject({ amount: usd(1000), finalCapture: false });
  });
});
