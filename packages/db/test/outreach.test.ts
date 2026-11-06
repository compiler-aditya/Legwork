import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { usd } from '@legwork/core';
import { ErrandMoney } from '@legwork/orchestrator';
import { FakePayments, webhooks } from '@legwork/orchestrator/testing';
import { OutreachEngine, type Caller } from '@legwork/outreach';
import type { CallVariables } from '@legwork/voice';
import { verifyCallToken } from '@legwork/voice';
import { PgErrandRepo, PgOutreachStore, PgPickupStore, migrate } from '../src';
import { openTestDatabase, type TestDatabase } from './harness';

const SECRET = 'call-token-secret-of-at-least-32-chars!';
let t: TestDatabase;

beforeAll(async () => {
  t = await openTestDatabase();
  await migrate(t.db);
  await t.db.query(`INSERT INTO users (id, name) VALUES ('usr_sam', 'Sam')`);
}, 60_000);
afterAll(async () => {
  await t?.close();
});

describe('PgOutreachStore under the outreach engine', () => {
  it('keeps the plan and every call in Postgres through both rounds', async () => {
    const calls: Array<{ to: string; variables: CallVariables }> = [];
    const caller: Caller = {
      place: async (input) => {
        calls.push(input);
        return { conversationId: `conv_${calls.length}` };
      },
    };
    const repo = new PgErrandRepo(t.db);
    const store = new PgOutreachStore(t.db);
    const money = new ErrandMoney({ payments: new FakePayments(), repo, pickupCode: () => '4821' });
    // The engine's lock (outreach:<id>) wraps the money service's (errand:<id>), on one session.
    const engine = new OutreachEngine({ store, errands: repo, money, caller, callTokenSecret: SECRET, lock: (key, fn) => t.db.withLock(key, fn) });
    const id = 'err_pg_rounds';
    const shops = [
      { businessId: 'biz_a', name: 'Shop A', phone: '+14155550111' },
      { businessId: 'biz_b', name: 'Shop B', phone: '+14155550112' },
    ];

    await money.createErrand({ id, userId: 'usr_sam', request: { kind: 'item', text: 'cartridge' }, budgetMax: usd(4000) });
    await engine.plan({ errandId: id, item: 'a cartridge', quantity: 1, pickupWindow: 'today', buyerFirstName: 'Sam', shops });
    await money.advance(id, 'PLAN_READY', 'planner');
    await money.requestHold(id, { returnUrl: 'https://r', cancelUrl: 'https://c', savePayPal: true, description: 'cartridge' });
    const { authorizationId } = await money.buyerApproved(id);
    await money.handlePayPalEvent(webhooks.authorizationCreated(authorizationId, id, usd(4000)));

    await engine.start(id);
    const claims = (n: number) => verifyCallToken(SECRET, calls[n]!.variables.call_token)!;
    await engine.recordQuote(claims(0), { inStock: true, price: usd(3300), readyAt: 'after 3', declinedAiCalls: false });
    await engine.recordQuote(claims(1), { inStock: true, price: usd(3000), readyAt: 'tomorrow', declinedAiCalls: false });
    const ended = (n: number) => ({ kind: 'transcript' as const, conversationId: `conv_${n + 1}`, agentId: 'a', status: 'done', lines: [{ line: 0, at: '0:05', seconds: 5, speaker: 'shop' as const, text: 'Thirty even.' }], toolCalls: [] });
    await engine.callEnded(ended(0)); // found by conversation id, as when the webhook carries no outreach id
    await engine.callEnded(ended(1));

    expect((await repo.get(id))!.state).toBe('confirming');
    expect(calls[2]).toMatchObject({ to: '+14155550112', variables: { round: '2', quoted_price: '30.00', offer_price: '30.00' } });

    const view = await engine.view(id);
    expect(view.plan?.shops.map((s) => s.businessId)).toEqual(['biz_a', 'biz_b']);
    expect(view.rows.map((r) => [r.id, r.status, r.result ?? null])).toEqual([
      [`${id}.r1.biz_a`, 'ended', 'quoted'],
      [`${id}.r1.biz_b`, 'ended', 'quoted'],
      [`${id}.r2.biz_b`, 'calling', null],
    ]);
    expect(view.rows[0]!.quote?.price).toEqual(usd(3300));
    expect(view.rows[1]!.transcript?.[0]?.text).toBe('Thirty even.');
    expect(view.rows[2]!.offer).toEqual({ ask: usd(3000), quoted: usd(3000) });
    const { rows } = await t.db.query<{ name: string }>(`SELECT name FROM businesses WHERE id = ANY($1) ORDER BY id`, [['biz_a', 'biz_b']]);
    expect(rows.map((r) => r.name)).toEqual(['Shop A', 'Shop B']);
  });
});

describe('PgPickupStore', () => {
  it('creates a pickup once per contract and finds open ones by the shop number', async () => {
    const pickups = new PgPickupStore(t.db);
    const p = { contractId: 'err_pg_rounds-c1', errandId: 'err_pg_rounds', shopPhone: '+14155550112', buyerPhone: '+14155559999', status: 'open' as const, wrongAttempts: 0 };
    expect(await pickups.create(p)).toBe(true);
    expect(await pickups.create(p)).toBe(false);
    expect(await pickups.openForShop('+14155550112')).toEqual([p]);
    await pickups.save({ ...p, status: 'locked', wrongAttempts: 5 });
    expect(await pickups.openForShop('+14155550112')).toEqual([]);
    expect(await pickups.forErrand('err_pg_rounds')).toEqual([{ ...p, status: 'locked', wrongAttempts: 5 }]);
  });
});
