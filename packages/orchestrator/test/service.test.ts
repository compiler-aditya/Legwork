import { beforeEach, describe, expect, it } from 'vitest';
import { usd } from '@legwork/core';
import { ErrandMoney, MemoryErrandRepo, type Deal } from '../src';
import { FakePayments, webhooks } from '../src/testing';

const ERRAND = 'err_tap1';
const hardwareDeal = (over: Partial<Deal> = {}): Deal => ({
  businessId: 'biz_hartley',
  outreachId: 'out_r2_hartley',
  item: 'Moen 1222 cartridge',
  quantity: 1,
  total: usd(3400),
  payout: { type: 'PHONE', receiver: '+14155550123', wallet: 'VENMO' },
  pickupAt: '2026-11-08T16:00:00-08:00',
  ...over,
});

let payments: FakePayments;
let repo: MemoryErrandRepo;
let money: ErrandMoney;

beforeEach(() => {
  payments = new FakePayments();
  repo = new MemoryErrandRepo();
  money = new ErrandMoney({ payments, repo, pickupCode: () => '4821' });
});

/** Request -> hold confirmed -> quotes -> confirming, the part every test shares. */
async function upToConfirming() {
  await money.createErrand({ id: ERRAND, userId: 'usr_sam', request: { kind: 'item', text: 'Moen 1222 cartridge for my shower' }, budgetMax: usd(4000) });
  await money.advance(ERRAND, 'PLAN_READY', 'planner');
  const { approveUrl } = await money.requestHold(ERRAND, {
    returnUrl: 'https://legwork.test/r',
    cancelUrl: 'https://legwork.test/c',
    savePayPal: true,
    description: 'Moen 1222 cartridge, up to $40',
  });
  expect(approveUrl).toContain('checkoutnow');
  await money.buyerApproved(ERRAND);
  expect(await money.handlePayPalEvent(webhooks.authorizationCreated('AUTH-1', ERRAND, usd(4000)))).toBe('hold confirmed');
  await money.advance(ERRAND, 'QUOTES_STARTED', 'orchestrator');
  await money.advance(ERRAND, 'QUOTES_DONE', 'orchestrator');
  await money.advance(ERRAND, 'BEST_CHOSEN', 'planner');
}

const state = async () => (await repo.get(ERRAND))!;

describe('the hero errand', () => {
  it('holds $40, pays a $10 deposit, settles $34 at pickup and pays the shop twice', async () => {
    await upToConfirming();
    const hold = payments.callsTo('createHoldOrder')[0]!;
    expect(hold.requestId).toBe('lw-err_tap1-hold');
    expect(hold.args).toMatchObject({ amount: usd(4000), referenceId: ERRAND, savePayPal: true });

    const confirm = await money.confirmDeal(ERRAND, hardwareDeal());
    expect(confirm).toEqual({ ok: true, contractId: 'err_tap1-c1', pickupCode: '4821', deposit: usd(1000) });

    await money.payDeposit(ERRAND);
    const depositCapture = payments.callsTo('captureAuthorization')[0]!;
    expect(depositCapture).toMatchObject({
      requestId: 'lw-err_tap1-capture-deposit',
      args: { authorizationId: 'AUTH-1', amount: usd(1000), finalCapture: false, invoiceId: 'err_tap1-deposit-0' },
    });
    expect((await state()).state).toBe('deposit_pending');
    expect(payments.callsTo('createPayout')).toHaveLength(0); // the shop is paid only after PayPal confirms the capture

    await money.handlePayPalEvent(webhooks.captureCompleted('CAP-2', 'err_tap1-deposit-0'));
    expect((await state()).state).toBe('deposit_paid');
    const depositPayout = payments.callsTo('createPayout')[0]!;
    expect(depositPayout.requestId).toBe('lw-err_tap1-payout-deposit');
    expect(depositPayout.args).toMatchObject({
      items: [{ recipientType: 'PHONE', receiver: '+14155550123', wallet: 'VENMO', amount: usd(1000), senderItemId: 'lw-err_tap1-payout-deposit' }],
    });
    await money.handlePayPalEvent(webhooks.payoutItem('SUCCEEDED', 'ITEM-1', 'lw-err_tap1-payout-deposit'));

    await money.advance(ERRAND, 'PICKUP_SCHEDULED', 'calendar');
    expect(await money.confirmPickupCode(ERRAND, '1234')).toEqual({ ok: false, reason: 'pickup code does not match' });
    expect(await money.confirmPickupCode(ERRAND, ' 4821 ')).toEqual({ ok: true });
    const balanceCapture = payments.callsTo('captureAuthorization')[1]!;
    expect(balanceCapture.args).toMatchObject({ amount: usd(2400), finalCapture: true, invoiceId: 'err_tap1-balance-0' });

    await money.handlePayPalEvent(webhooks.captureCompleted('CAP-4', 'err_tap1-balance-0'));
    const done = await state();
    expect(done.state).toBe('settled');
    expect(payments.callsTo('createPayout')[1]!.args).toMatchObject({ items: [{ amount: usd(2400) }] });

    expect(repo.moneySteps.map((s) => `${s.kind}:${s.amount.cents}:${s.status}`)).toEqual([
      'authorize:4000:confirmed',
      'capture_deposit:1000:confirmed',
      'payout_deposit:1000:confirmed',
      'capture_balance:2400:confirmed',
      'payout_balance:2400:sent',
    ]);
    expect(repo.transitions.map((t) => t.to).at(-1)).toBe('settled');
  });

  it('refuses a price above the hold and stays on the call', async () => {
    await upToConfirming();
    const result = await money.confirmDeal(ERRAND, hardwareDeal({ total: usd(4100) }));
    expect(result).toEqual({ ok: false, reason: 'price is above the $40.00 held for this errand' });
    expect((await state()).state).toBe('confirming');
    expect(await money.confirmDeal(ERRAND, hardwareDeal({ quantity: 0 }))).toMatchObject({ ok: false });
  });

  it('releases the whole hold when no quote is good enough', async () => {
    await upToConfirming();
    await money.advance(ERRAND, 'SHOP_DECLINED', 'round 2 call');
    await money.noDeal(ERRAND, 'every quote above the online price');
    expect(payments.callsTo('voidAuthorization')[0]).toMatchObject({ requestId: 'lw-err_tap1-void', args: { authorizationId: 'AUTH-1' } });
    expect((await state()).state).toBe('releasing');
    await money.handlePayPalEvent(webhooks.authorizationVoided('AUTH-1', ERRAND));
    expect((await state()).state).toBe('released');
  });
});

describe('a shop cancels after the deposit', () => {
  it('refunds the deposit, cancels the unclaimed payout, and rebooks inside what is still held', async () => {
    await upToConfirming();
    await money.confirmDeal(ERRAND, hardwareDeal());
    await money.payDeposit(ERRAND);
    await money.handlePayPalEvent(webhooks.captureCompleted('CAP-2', 'err_tap1-deposit-0'));
    await money.handlePayPalEvent(webhooks.payoutItem('UNCLAIMED', 'ITEM-9', 'lw-err_tap1-payout-deposit'));

    await money.shopCancelled(ERRAND, 'shop texted: sold the last one');
    expect(payments.callsTo('refundCapture')[0]).toMatchObject({ requestId: 'lw-err_tap1-refund-deposit', args: { captureId: 'CAP-2', amount: usd(1000) } });
    expect(payments.callsTo('cancelPayoutItem')[0]?.args).toEqual({ payoutItemId: 'ITEM-9' });
    const afterCancel = await state();
    expect(afterCancel.state).toBe('comparing');
    expect(afterCancel.attention).toBeUndefined();
    expect(afterCancel.hold?.remaining).toEqual(usd(3000)); // a refund does not restore the authorization

    await money.advance(ERRAND, 'BEST_CHOSEN', 'next-best quote');
    expect(await money.confirmDeal(ERRAND, hardwareDeal({ businessId: 'biz_corner', total: usd(3400) }))).toMatchObject({ ok: false });
    expect(await money.confirmDeal(ERRAND, hardwareDeal({ businessId: 'biz_corner', total: usd(2800) }))).toMatchObject({
      ok: true,
      contractId: 'err_tap1-c2',
      deposit: usd(800),
    });
    await money.payDeposit(ERRAND);
    expect(payments.callsTo('captureAuthorization')[1]).toMatchObject({
      requestId: 'lw-err_tap1-capture-deposit-1',
      args: { invoiceId: 'err_tap1-deposit-1', amount: usd(800) },
    });
    // A late webhook for the cancelled contract changes nothing.
    expect(await money.handlePayPalEvent(webhooks.captureCompleted('CAP-2', 'err_tap1-deposit-0'))).toBe('ignored: capture for an earlier contract');
  });

  it('flags a deposit the shop already claimed', async () => {
    await upToConfirming();
    await money.confirmDeal(ERRAND, hardwareDeal());
    await money.payDeposit(ERRAND);
    await money.handlePayPalEvent(webhooks.captureCompleted('CAP-2', 'err_tap1-deposit-0'));
    await money.handlePayPalEvent(webhooks.payoutItem('SUCCEEDED', 'ITEM-2', 'lw-err_tap1-payout-deposit'));
    const after = await money.shopCancelled(ERRAND, 'shop cancelled');
    expect(payments.callsTo('cancelPayoutItem')).toHaveLength(0);
    expect(after.attention).toMatch(/SUCCEEDED/);
  });
});

describe('webhook safety', () => {
  it('ignores a duplicate hold confirmation and events for unknown errands', async () => {
    await upToConfirming();
    expect(await money.handlePayPalEvent(webhooks.authorizationCreated('AUTH-1', ERRAND, usd(4000)))).toBe('ignored: errand is confirming');
    await expect(money.handlePayPalEvent(webhooks.authorizationCreated('AUTH-X', 'err_nope', usd(100)))).rejects.toThrow(/No errand/);
    expect(await money.handlePayPalEvent(webhooks.captureCompleted('CAP-X', 'someone-elses-invoice'))).toBe('ignored: capture without a Legwork invoice id');
    expect(repo.transitions.filter((t) => t.event === 'HOLD_CONFIRMED')).toHaveLength(1);
  });

  it('handles a capture webhook that arrives while the capture call is still running', async () => {
    await upToConfirming();
    await money.confirmDeal(ERRAND, hardwareDeal());
    let raced: Promise<string> | undefined;
    payments.onCapture = (id, input) => {
      raced = money.handlePayPalEvent(webhooks.captureCompleted(id, input.invoiceId!));
    };
    await money.payDeposit(ERRAND);
    expect(await raced).toBe('deposit captured, shop paid');
    expect((await state()).state).toBe('deposit_paid');
  });

  it('records a denied capture for a person to resolve', async () => {
    await upToConfirming();
    await money.confirmDeal(ERRAND, hardwareDeal());
    await money.payDeposit(ERRAND);
    expect(await money.handlePayPalEvent(webhooks.captureDenied('CAP-2', 'err_tap1-deposit-0'))).toBe('deposit capture denied');
    const after = await state();
    expect(after.state).toBe('deposit_pending');
    expect(after.attention).toMatch(/denied/);
  });
});
