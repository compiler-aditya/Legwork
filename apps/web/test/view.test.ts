import { describe, expect, it } from 'vitest';
import { callResult, confirmation, headline, moneyTrack, needsReview, stepIndex, timeline, type CallRow, type Errand, type ErrandView } from '../lib/view';

const m = (cents: number) => ({ cents, currency: 'USD' });
const contract = { id: 'err_1-c1', businessId: 'biz_hartley', item: 'Moen 1222 cartridge', quantity: 1, total: m(3200), deposit: m(900), pickupCode: '4821', payout: { type: 'PHONE', receiver: '+14155550101' } };
const errand = (over: Partial<Errand> = {}): Errand => ({
  id: 'err_1',
  state: 'quoting',
  request: { kind: 'item', text: 'cartridge' },
  budgetMax: m(4000),
  hold: { orderId: 'O1', authorizationId: 'A1', remaining: m(4000) },
  captures: {},
  payouts: {},
  cancelledContracts: [],
  ...over,
});
const row = (over: Partial<CallRow>): CallRow => ({ id: 'r', businessId: 'biz_hartley', round: 1, status: 'ended', attempt: 1, ...over });

describe('the money track', () => {
  it('shows the hold, deposit, balance and what is released, in order', () => {
    const settled = errand({ state: 'settled', contract, captures: { deposit: 'C1', balance: 'C2' }, payouts: { deposit: { status: 'SUCCEEDED' }, balance: { status: 'sent' } } });
    expect(moneyTrack(settled).map((l) => [l.label, l.amount, l.status])).toEqual([
      ['Budget held', '$40.00', 'done'],
      ['Deposit to the shop', '$9.00', 'done'],
      ['Balance at pickup', '$23.00', 'done'],
      ['Released to you', '$8.00', 'done'],
    ]);
    expect(moneyTrack(settled)[1]!.detail).toBe('Captured; payout succeeded');
  });

  it('waits for approval before anything is held, and shows a release when nobody could do it', () => {
    expect(moneyTrack(errand({ state: 'hold_pending', hold: { orderId: 'O1', remaining: m(4000) } }))[0]).toMatchObject({ status: 'pending', detail: 'Waiting for your approval in PayPal' });
    expect(moneyTrack(errand({ state: 'released' })).map((l) => [l.label, l.status])).toEqual([
      ['Budget held', 'done'],
      ['Hold released', 'done'],
    ]);
  });
});

describe('calls', () => {
  it('says what happened on each call', () => {
    expect(callResult(row({ result: 'quoted', quote: { inStock: true, price: m(3400), readyAt: 'after 3' } }))).toBe('Quoted $34.00, ready after 3');
    expect(callResult(row({ status: 'calling' }))).toBe('On the call');
    expect(callResult(row({ result: 'opted_out' }))).toBe('Asked not to be called by an AI');
  });

  it('puts calls on a timeline, a live call running to now', () => {
    const now = new Date('2026-11-08T21:10:00Z');
    const view: ErrandView = {
      errand: errand(),
      outreach: {
        plan: { item: 'x', quantity: 1, pickupWindow: 'today', buyerFirstName: 'Sam', shops: [{ businessId: 'biz_hartley', name: 'Hartley', phone: '+1' }] },
        rows: [
          row({ id: 'a', startedAt: '2026-11-08T21:00:00Z', endedAt: '2026-11-08T21:02:00Z', result: 'quoted', quote: { inStock: true, price: m(3400), readyAt: '' } }),
          row({ id: 'b', round: 2, status: 'calling', startedAt: '2026-11-08T21:08:00Z' }),
        ],
      },
      pickups: [],
    };
    const t = timeline(view, now);
    expect(t.resources).toEqual([{ id: 'biz_hartley', name: 'Hartley' }]);
    expect(t.events.map((e) => [e.name, e.eventColor])).toEqual([
      ['Quote: Quoted $34.00', 'green'],
      ['Confirm: On the call', 'blue'],
    ]);
    expect(t.events[1]!.endDate).toEqual(now);
    expect(t.start.toISOString()).toBe('2026-11-08T20:58:00.000Z');
  });

  it('finds the confirmation call and whether its reading needs the buyer', () => {
    const confirmed = row({ id: 'c', round: 2, result: 'confirmed', review: { agreed: true, mismatches: [], unverified: [] } });
    const view = { errand: errand({ contract }), outreach: { rows: [row({ id: 'a' }), confirmed] }, pickups: [] };
    expect(confirmation(view)?.id).toBe('c');
    expect(needsReview(confirmed.review!)).toBe(false);
    expect(needsReview({ agreed: true, mismatches: [{ field: 'totalCents', fromTranscript: 3200, fromTools: 3400 }], unverified: [] })).toBe(true);
  });
});

describe('headlines and steps', () => {
  it('maps every errand state to a step and a headline', () => {
    expect(stepIndex('quoting')).toBe(2);
    expect(stepIndex('settled')).toBe(6);
    expect(headline('awaiting_pickup')).toEqual({ title: 'Ready for pickup', tone: 'good' });
  });
});
