import { beforeEach, describe, expect, it } from 'vitest';
import { usd } from '@legwork/core';
import { ErrandMoney, MemoryErrandRepo } from '@legwork/orchestrator';
import { FakePayments, webhooks } from '@legwork/orchestrator/testing';
import { toDeal, verifyCallToken, type CallReport, type CallVariables, type ConfirmOrderInput } from '@legwork/voice';
import { MemoryOutreachStore, OutreachEngine, consentingOnly, counterOffer, type Caller, type OutreachPlan } from '../src';

const SECRET = 'call-token-secret-of-at-least-32-chars!';
const ERRAND = 'err_tap1';
const SHOPS = [
  { businessId: 'biz_hartley', name: 'Hartley Hardware', phone: '+14155550101' },
  { businessId: 'biz_corner', name: 'Corner Plumbing Supply', phone: '+14155550102' },
  { businessId: 'biz_mission', name: 'Mission Ace', phone: '+14155550103' },
  { businessId: 'biz_reserve', name: 'Reserve Hardware', phone: '+14155550104' },
];
const plan = (over: Partial<OutreachPlan> = {}): OutreachPlan => ({
  errandId: ERRAND,
  item: 'a Moen 1222 shower cartridge',
  quantity: 1,
  pickupWindow: 'today after 3pm',
  buyerFirstName: 'Sam',
  benchmark: { price: usd(3100), source: 'Channel3: Home Depot online' },
  shops: SHOPS,
  ...over,
});

class FakeCaller implements Caller {
  readonly calls: Array<{ to: string; variables: CallVariables; conversationId: string }> = [];
  fail?: (to: string) => boolean;
  async place(input: { to: string; variables: CallVariables }) {
    if (this.fail?.(input.to)) throw new Error('Twilio: number unreachable');
    const conversationId = `conv_${this.calls.length + 1}`;
    this.calls.push({ ...input, conversationId });
    return { conversationId };
  }
  to(phone: string) {
    return this.calls.filter((c) => c.to === phone);
  }
}

let now: Date;
let payments: FakePayments;
let repo: MemoryErrandRepo;
let money: ErrandMoney;
let store: MemoryOutreachStore;
let caller: FakeCaller;
let engine: OutreachEngine;

beforeEach(async () => {
  now = new Date('2026-11-08T21:00:00Z');
  payments = new FakePayments();
  repo = new MemoryErrandRepo();
  money = new ErrandMoney({ payments, repo, pickupCode: () => '4821' });
  store = new MemoryOutreachStore();
  caller = new FakeCaller();
  engine = new OutreachEngine({ store, errands: repo, money, caller, callTokenSecret: SECRET, now: () => now });
});

/** The errand with its $40 hold confirmed by PayPal, and the plan saved. */
async function held(p: OutreachPlan = plan()) {
  await money.createErrand({ id: ERRAND, userId: 'usr_sam', request: { kind: 'item', text: 'Moen 1222 cartridge' }, budgetMax: usd(4000) });
  await engine.plan(p);
  await money.advance(ERRAND, 'PLAN_READY', 'planner');
  await money.requestHold(ERRAND, { returnUrl: 'https://r', cancelUrl: 'https://c', savePayPal: true, description: 'cartridge' });
  await money.buyerApproved(ERRAND);
  await money.handlePayPalEvent(webhooks.authorizationCreated('AUTH-1', ERRAND, usd(4000)));
}

const claimsOf = (phone: string, n = 0) => verifyCallToken(SECRET, caller.to(phone)[n]!.variables.call_token, now.getTime())!;
const quote = (phone: string, price: number | undefined, inStock = true) =>
  engine.recordQuote(claimsOf(phone), { inStock, ...(price === undefined ? {} : { price: usd(price) }), readyAt: 'after 3', declinedAiCalls: false });
const ended = (phone: string, n = 0): CallReport => {
  const call = caller.to(phone)[n]!;
  return { kind: 'transcript', conversationId: call.conversationId, agentId: 'agent', status: 'done', outreachId: call.variables.outreach_id, lines: [], toolCalls: [] };
};
const noAnswer = (phone: string, n = 0, reason: 'no-answer' | 'busy' = 'no-answer'): CallReport => {
  const call = caller.to(phone)[n]!;
  return { kind: 'not_connected', conversationId: call.conversationId, agentId: 'agent', reason, outreachId: call.variables.outreach_id };
};
/** What the confirm_order tool does with what the shop agreed. */
const confirm = (phone: string, total: string, n = 0) => {
  const claims = claimsOf(phone, n);
  const input: ConfirmOrderInput = { item: 'Moen 1222', quantity: 1, total, ready_at: 'after 3', payout_method: 'this_phone_venmo', payout_receiver: '' };
  return money.confirmDeal(claims.errandId, toDeal(claims, input));
};
const state = async () => (await repo.get(ERRAND))!.state;

describe('the hero errand', () => {
  it('calls three shops, calls the cheapest back with a counter-offer, and ends with a contract', async () => {
    await held();
    const rows = await engine.start(ERRAND);
    expect(rows.map((r) => r.businessId)).toEqual(['biz_hartley', 'biz_corner', 'biz_mission']); // at most 3 at once
    expect(await state()).toBe('quoting');
    expect(caller.calls[0]!.variables).toMatchObject({ round: '1', business_name: 'Hartley Hardware', buyer_first_name: 'Sam', quoted_price: '', offer_price: '' });
    expect(claimsOf(SHOPS[0]!.phone)).toMatchObject({ errandId: ERRAND, businessId: 'biz_hartley', round: 1, dialled: SHOPS[0]!.phone });

    await quote(SHOPS[0]!.phone, 3400);
    await quote(SHOPS[1]!.phone, 3800);
    await quote(SHOPS[2]!.phone, undefined, false);
    expect(await engine.callEnded(ended(SHOPS[0]!.phone))).toBe('biz_hartley: quoted');
    expect(await engine.callEnded(ended(SHOPS[2]!.phone))).toBe('biz_mission: unavailable');
    expect(await state()).toBe('quoting'); // one call still live
    await engine.callEnded(ended(SHOPS[1]!.phone));

    expect(await state()).toBe('confirming');
    const callback = caller.to(SHOPS[0]!.phone)[1]!;
    expect(callback.variables).toMatchObject({ round: '2', quoted_price: '34.00', offer_price: '31.00' }); // online $31 is within 10%
    expect(claimsOf(SHOPS[0]!.phone, 1).round).toBe(2);

    expect(await confirm(SHOPS[0]!.phone, '32.00', 1)).toMatchObject({ ok: true, contractId: `${ERRAND}-c1` });
    expect(await engine.callEnded(ended(SHOPS[0]!.phone, 1))).toBe('biz_hartley: confirmed');
    expect(await state()).toBe('contracted');
    expect(repo.transitions.map((t) => t.event)).toEqual([
      'PLAN_READY', 'HOLD_REQUESTED', 'HOLD_CONFIRMED', 'QUOTES_STARTED', 'QUOTES_DONE', 'BEST_CHOSEN', 'CONTRACT_CONFIRMED',
    ]);
    expect(repo.transitions.find((t) => t.event === 'BEST_CHOSEN')!.cause).toBe('biz_hartley at $34.00, asking $31.00');
  });
});

describe('when shops do not come through', () => {
  it('calls a shop that did not answer once more, after the retry delay', async () => {
    await held(plan({ shops: SHOPS.slice(0, 1) }));
    await engine.start(ERRAND);
    expect(await engine.callEnded(noAnswer(SHOPS[0]!.phone))).toMatch(/^no_answer; calling again/);
    expect(await engine.tick()).toEqual([]); // not yet
    now = new Date(now.getTime() + 2 * 60_000);
    expect(await engine.tick()).toEqual([`${ERRAND}.r1.biz_hartley: call 2 placed`]);
    // A late report for the first call changes nothing.
    expect(await engine.callEnded(noAnswer(SHOPS[0]!.phone, 0))).toBe('ignored: not the live call');
    await engine.callEnded(noAnswer(SHOPS[0]!.phone, 1, 'busy'));
    // Nobody quoted: the hold is released.
    expect(await state()).toBe('releasing');
    expect(payments.callsTo('voidAuthorization')).toHaveLength(1);
  });

  it('tries the next best quote when the first shop will not confirm, then releases the hold', async () => {
    await held(plan({ benchmark: undefined }));
    await engine.start(ERRAND);
    await quote(SHOPS[0]!.phone, 3400);
    await quote(SHOPS[1]!.phone, 3600);
    await quote(SHOPS[2]!.phone, 4500); // above the $40 held
    for (const s of SHOPS.slice(0, 3)) await engine.callEnded(ended(s.phone));

    expect(caller.to(SHOPS[0]!.phone)[1]!.variables).toMatchObject({ round: '2', quoted_price: '34.00', offer_price: '34.00' });
    await engine.callEnded(ended(SHOPS[0]!.phone, 1)); // no confirmation on the call
    expect(caller.to(SHOPS[1]!.phone)[1]!.variables).toMatchObject({ round: '2', quoted_price: '36.00' });
    expect(caller.to(SHOPS[2]!.phone)).toHaveLength(1); // never called back: above the hold
    await engine.callEnded(ended(SHOPS[1]!.phone, 1));

    expect(await state()).toBe('releasing');
    expect(repo.transitions.map((t) => t.event).slice(3)).toEqual([
      'QUOTES_STARTED', 'QUOTES_DONE', 'BEST_CHOSEN', 'SHOP_DECLINED', 'BEST_CHOSEN', 'SHOP_DECLINED', 'NO_GOOD_QUOTE',
    ]);
  });

  it('moves to the next shop after a confirmed shop cancels', async () => {
    await held(plan({ benchmark: undefined }));
    await engine.start(ERRAND);
    await quote(SHOPS[0]!.phone, 3400);
    await quote(SHOPS[1]!.phone, 3500);
    for (const s of SHOPS.slice(0, 3)) await engine.callEnded(ended(s.phone));
    await confirm(SHOPS[0]!.phone, '34.00', 1);
    await engine.callEnded(ended(SHOPS[0]!.phone, 1));

    await money.shopCancelled(ERRAND, 'shop texted: sold out');
    await engine.afterShopCancelled(ERRAND);
    expect(await state()).toBe('confirming');
    expect(caller.to(SHOPS[1]!.phone)[1]!.variables).toMatchObject({ round: '2', quoted_price: '35.00' });
  });

  it('ends a call that never reports, keeping a quote it recorded', async () => {
    await held(plan({ shops: SHOPS.slice(0, 2) }));
    await engine.start(ERRAND);
    await quote(SHOPS[0]!.phone, 3400);
    await engine.callEnded(ended(SHOPS[1]!.phone));
    now = new Date(now.getTime() + 21 * 60_000);
    expect(await engine.tick()).toEqual([`${ERRAND}.r1.biz_hartley: no report, ended as quoted`]);
    expect(await state()).toBe('confirming');
  });

  it('records a call it could not place, and a shop that asked not to be called by an AI', async () => {
    await held(plan({ shops: SHOPS.slice(0, 2) }));
    caller.fail = (to) => to === SHOPS[1]!.phone;
    const rows = await engine.start(ERRAND);
    expect(rows[1]).toMatchObject({ status: 'ended', result: 'call_failed', error: 'Twilio: number unreachable' });
    await engine.recordQuote(claimsOf(SHOPS[0]!.phone), { inStock: false, readyAt: '', declinedAiCalls: true });
    expect(await engine.callEnded(ended(SHOPS[0]!.phone))).toBe('biz_hartley: opted_out');
    expect(await state()).toBe('releasing');
  });
});

describe('guards', () => {
  it('only dials numbers whose owners agreed to AI calls', async () => {
    const guarded = consentingOnly(caller, [SHOPS[0]!.phone]);
    await expect(guarded.place({ to: SHOPS[1]!.phone, variables: {} as CallVariables })).rejects.toThrow(/has not agreed/);
    await expect(guarded.place({ to: SHOPS[0]!.phone, variables: {} as CallVariables })).resolves.toEqual({ conversationId: 'conv_1' });
  });

  it('starts only once the hold is confirmed, and checks the plan', async () => {
    await money.createErrand({ id: ERRAND, userId: 'usr_sam', request: { kind: 'item', text: 'x' }, budgetMax: usd(4000) });
    await expect(engine.plan(plan({ shops: [] }))).rejects.toThrow(/at least one shop/);
    await expect(engine.plan(plan({ shops: [{ ...SHOPS[0]!, phone: '415-555-0101' }] }))).rejects.toThrow(/E\.164/);
    await engine.plan(plan());
    expect(await engine.start(ERRAND)).toEqual([]); // still "requested": no calls
    expect(caller.calls).toHaveLength(0);
  });

  it('ignores a quote from a token for another errand', async () => {
    await held();
    await engine.start(ERRAND);
    const claims = { ...claimsOf(SHOPS[0]!.phone), errandId: 'err_other' };
    expect(await engine.recordQuote(claims, { inStock: true, price: usd(100), readyAt: 'now', declinedAiCalls: false })).toBe('ignored: unknown outreach');
  });
});

describe('the counter-offer', () => {
  it('asks towards the online price, never below 90% of the quote, in whole dollars', () => {
    expect(counterOffer(usd(3400), usd(3100))).toEqual(usd(3100));
    expect(counterOffer(usd(3400), usd(2500))).toEqual(usd(3100)); // floor: 90% of $34 is $30.60, rounded up
    expect(counterOffer(usd(3400), usd(3650))).toEqual(usd(3400)); // online is dearer: no counter
    expect(counterOffer(usd(3400))).toEqual(usd(3400));
    expect(counterOffer(usd(3450), usd(3420))).toEqual(usd(3450)); // rounds up to $35, capped at the quote
  });
});
