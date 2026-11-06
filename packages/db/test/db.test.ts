import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { usd } from '@legwork/core';
import { ErrandMoney, type Deal } from '@legwork/orchestrator';
import { FakePayments, webhooks } from '@legwork/orchestrator/testing';
import { PgErrandRepo, PgEventStore, migrate } from '../src';
import { openTestDatabase, type TestDatabase } from './harness';

let t: TestDatabase;
let repo: PgErrandRepo;

beforeAll(async () => {
  t = await openTestDatabase();
  repo = new PgErrandRepo(t.db);
}, 60_000);
afterAll(async () => {
  await t?.close();
});

const deal: Deal = {
  businessId: 'biz_hartley',
  outreachId: 'out_r2_hartley',
  item: 'Moen 1222 cartridge',
  quantity: 1,
  total: usd(3400),
  payout: { type: 'PHONE', receiver: '+14155550123', wallet: 'VENMO' },
};

/** Walks an errand from request to the round-2 call, on whatever service and repo it is given. */
async function toConfirming(money: ErrandMoney, id: string) {
  await money.createErrand({ id, userId: 'usr_sam', request: { kind: 'item', text: 'Moen 1222 cartridge' }, budgetMax: usd(4000) });
  await money.advance(id, 'PLAN_READY', 'planner');
  await money.requestHold(id, { returnUrl: 'https://legwork.test/r', cancelUrl: 'https://legwork.test/c', savePayPal: true, description: 'cartridge' });
  const { authorizationId } = await money.buyerApproved(id);
  await money.handlePayPalEvent(webhooks.authorizationCreated(authorizationId, id, usd(4000)));
  await money.advance(id, 'QUOTES_STARTED', 'orchestrator');
  await money.advance(id, 'QUOTES_DONE', 'orchestrator');
  await money.advance(id, 'BEST_CHOSEN', 'planner');
}

describe('migrations', () => {
  it('applies every migration once', async () => {
    expect(await migrate(t.db)).toEqual(['001_init.sql', '002_errand_money.sql', '003_outreach_rounds.sql', '004_pickups.sql', '005_contract_reviews.sql']);
    expect(await migrate(t.db)).toEqual([]);
    await t.db.query(`INSERT INTO users (id, name) VALUES ('usr_sam', 'Sam') ON CONFLICT DO NOTHING`);
  });
});

describe('PgErrandRepo under the orchestrator', () => {
  it('runs the hero errand and keeps every dollar as rows', async () => {
    const payments = new FakePayments();
    const money = new ErrandMoney({ payments, repo, pickupCode: () => '4821' });
    const id = 'err_pg_hero';
    await toConfirming(money, id);
    await money.confirmDeal(id, deal);
    await money.payDeposit(id);
    expect(await money.handlePayPalEvent(webhooks.captureCompleted('CAP-2', `${id}-deposit-0`))).toBe('deposit captured, shop paid');
    await money.handlePayPalEvent(webhooks.payoutItem('SUCCEEDED', 'ITEM-77', `lw-${id}-payout-deposit`));
    await money.advance(id, 'PICKUP_SCHEDULED', 'calendar');
    expect(await money.confirmPickupCode(id, '4821')).toEqual({ ok: true });
    await money.handlePayPalEvent(webhooks.captureCompleted('CAP-4', `${id}-balance-0`));

    const errand = (await repo.get(id))!;
    expect(errand).toMatchObject({
      state: 'settled',
      request: { kind: 'item', text: 'Moen 1222 cartridge' },
      budgetMax: usd(4000),
      hold: { remaining: usd(0) }, // the final capture released the unused $6
      contract: { id: `${id}-c1`, total: usd(3400), deposit: usd(1000), pickupCode: '4821' },
      payouts: { deposit: { status: 'SUCCEEDED', itemId: 'ITEM-77' }, balance: { status: 'sent' } },
    });
    expect(errand.attention).toBeUndefined();

    const steps = await repo.moneySteps(id);
    expect(steps.map((s) => `${s.kind}:${s.amount.cents}:${s.status}`)).toEqual([
      'authorize:4000:confirmed',
      'capture_deposit:1000:confirmed',
      'payout_deposit:1000:confirmed',
      'capture_balance:2400:confirmed',
      'payout_balance:2400:sent',
    ]);
    expect(steps[2]!.paypalId).toBe('ITEM-77');
    expect((await repo.transitions(id)).map((x) => x.to)).toEqual([
      'planned', 'hold_pending', 'held', 'quoting', 'comparing', 'confirming', 'contracted',
      'deposit_pending', 'deposit_paid', 'awaiting_pickup', 'settling', 'settled',
    ]);
  });

  it('refuses to rewrite or delete money rows, and keeps confirmed steps confirmed', async () => {
    const requestId = 'lw-err_pg_hero-capture-deposit';
    await expect(t.db.query(`UPDATE money_steps SET amount_cents = 1 WHERE request_id = $1`, [requestId])).rejects.toThrow(/immutable/);
    await expect(t.db.query(`DELETE FROM money_steps WHERE request_id = $1`, [requestId])).rejects.toThrow(/append-only/);
    await expect(t.db.query(`UPDATE money_steps SET status = 'failed' WHERE request_id = $1`, [requestId])).rejects.toThrow(/already confirmed/);
    // The repo treats a late failure for a confirmed step as a no-op instead of an error.
    await repo.markMoneyStep(requestId, { status: 'failed' });
    expect((await repo.moneySteps('err_pg_hero'))[1]!.status).toBe('confirmed');
    await expect(repo.appendMoneyStep({ requestId, errandId: 'err_pg_hero', kind: 'capture_deposit', amount: usd(1000), status: 'sent' })).rejects.toThrow();
  });

  it('keeps attention and cancelled contracts across a reload', async () => {
    const payments = new FakePayments();
    const money = new ErrandMoney({ payments, repo, pickupCode: () => '1111' });
    const id = 'err_pg_cancel';
    await toConfirming(money, id);
    await money.confirmDeal(id, deal);
    await money.payDeposit(id);
    await money.handlePayPalEvent(webhooks.captureCompleted('CAP-2', `${id}-deposit-0`));
    await money.handlePayPalEvent(webhooks.payoutItem('SUCCEEDED', 'ITEM-5', `lw-${id}-payout-deposit`));
    await money.shopCancelled(id, 'sold the last one');
    const errand = (await repo.get(id))!;
    expect(errand.state).toBe('comparing');
    expect(errand.cancelledContracts).toHaveLength(1);
    expect(errand.contract).toBeUndefined();
    expect(errand.hold?.remaining).toEqual(usd(3000));
    expect(errand.attention).toMatch(/SUCCEEDED/);
    expect(await repo.needingAttention()).toEqual([{ id, attention: errand.attention }]);
    expect((await repo.moneySteps(id)).at(-1)).toMatchObject({ kind: 'refund', amount: usd(1000), status: 'sent' });
  });

  it.runIf(!!process.env.TEST_DATABASE_URL)('lets only one of two processes confirm the same deal', async () => {
    // Two services with separate in-process queues and separate connection
    // pools: only the Postgres advisory lock keeps them apart.
    const repoB = new PgErrandRepo(t.another!());
    const a = new ErrandMoney({ payments: new FakePayments(), repo, pickupCode: () => '2222' });
    const b = new ErrandMoney({ payments: new FakePayments(), repo: repoB, pickupCode: () => '3333' });
    const id = 'err_pg_race';
    await toConfirming(a, id);
    const results = await Promise.all([a.confirmDeal(id, deal), b.confirmDeal(id, { ...deal, businessId: 'biz_corner' })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: 'errand is contracted, not confirming' });
    expect((await repo.transitions(id)).filter((x) => x.event === 'CONTRACT_CONFIRMED')).toHaveLength(1);
  });
});

describe('PgEventStore', () => {
  it('hands an event out again until its handler finishes, then treats copies as duplicates', async () => {
    const events = new PgEventStore(t.db);
    const event = { id: 'WH-PG-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP1' } };
    expect(await events.claim('paypal', event)).toBe(true);
    expect(await events.claim('paypal', event)).toBe(true); // handler crashed before finishing
    await events.markProcessed('paypal', event.id);
    expect(await events.claim('paypal', event)).toBe(false);
    expect(await events.claim('elevenlabs', event)).toBe(true); // ids are per source
    const { rows } = await t.db.query<{ payload: { resource: { id: string } } }>(`SELECT payload FROM webhook_events WHERE source = 'paypal' AND event_id = 'WH-PG-1'`);
    expect(rows[0]!.payload.resource.id).toBe('CAP1');
  });
});
