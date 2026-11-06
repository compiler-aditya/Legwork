import { beforeEach, describe, expect, it } from 'vitest';
import { usd } from '@legwork/core';
import { ErrandMoney, MemoryErrandRepo, type Deal } from '@legwork/orchestrator';
import { FakePayments, webhooks } from '@legwork/orchestrator/testing';
import { MemoryOutreachStore, type OutreachPlan } from '@legwork/outreach';
import { MemoryPickupStore, PickupDesk, TwilioSms, signTwilio, twiml, verifyTwilioSignature } from '../src';

describe('Twilio', () => {
  it('signs webhooks the way Twilio documents', () => {
    // The example in Twilio's webhook security docs; Twilio's own library agrees.
    const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
    const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
    expect(signTwilio('12345', url, params)).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
    expect(verifyTwilioSignature('12345', url, params, '0/KCTR6DLpKmkAf8muzZqo1nDgQ=')).toBe(true);
    expect(verifyTwilioSignature('12345', url, { ...params, Digits: '9999' }, '0/KCTR6DLpKmkAf8muzZqo1nDgQ=')).toBe(false);
    expect(verifyTwilioSignature('12345', `${url}&x=1`, params, '0/KCTR6DLpKmkAf8muzZqo1nDgQ=')).toBe(false);
    expect(verifyTwilioSignature('12345', url, params, undefined)).toBe(false);
  });

  it('sends a text with the Messages API', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ sid: 'SM1', status: 'queued' }), { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const sms = new TwilioSms({ accountSid: 'AC1', authToken: 'tok', from: '+14155550000', fetch });
    expect(await sms.send('+14155550123', 'Hello & welcome')).toEqual({ sid: 'SM1' });
    expect(seen[0]!.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json');
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('AC1:tok').toString('base64')}`);
    expect(Object.fromEntries(new URLSearchParams(String(seen[0]!.init.body)))).toEqual({ To: '+14155550123', From: '+14155550000', Body: 'Hello & welcome' });
  });

  it('replies in TwiML, escaped', () => {
    expect(twiml('A < B & C')).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Message>A &lt; B &amp; C</Message></Response>');
    expect(twiml()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });
});

const ERRAND = 'err_tap1';
const SHOP = '+14155550101';
const BUYER = '+14155559999';
const plan: OutreachPlan = {
  errandId: ERRAND,
  item: 'a Moen 1222 shower cartridge',
  quantity: 1,
  pickupWindow: 'today after 3pm',
  buyerFirstName: 'Sam',
  buyerPhone: BUYER,
  shops: [{ businessId: 'biz_hartley', name: 'Hartley Hardware', phone: SHOP }],
};
const deal: Deal = {
  businessId: 'biz_hartley',
  outreachId: 'out_1',
  item: 'Moen 1222 cartridge',
  quantity: 1,
  total: usd(3400),
  payout: { type: 'PHONE', receiver: SHOP, wallet: 'VENMO' },
  pickupAt: 'today after 3',
};

let payments: FakePayments;
let repo: MemoryErrandRepo;
let money: ErrandMoney;
let texts: Array<{ to: string; body: string }>;
let desk: PickupDesk;

beforeEach(async () => {
  payments = new FakePayments();
  repo = new MemoryErrandRepo();
  money = new ErrandMoney({ payments, repo, pickupCode: () => '4821' });
  texts = [];
  const plans = new MemoryOutreachStore();
  await plans.savePlan(plan);
  desk = new PickupDesk({ money, errands: repo, plans, store: new MemoryPickupStore(), sms: { send: async (to, body) => texts.push({ to, body }) } });

  // An errand with its deposit paid to the shop.
  await money.createErrand({ id: ERRAND, userId: 'usr_sam', request: { kind: 'item', text: 'cartridge' }, budgetMax: usd(4000) });
  await money.advance(ERRAND, 'PLAN_READY', 'planner');
  await money.requestHold(ERRAND, { returnUrl: 'https://r', cancelUrl: 'https://c', savePayPal: true, description: 'cartridge' });
  await money.buyerApproved(ERRAND);
  await money.handlePayPalEvent(webhooks.authorizationCreated('AUTH-1', ERRAND, usd(4000)));
  for (const e of ['QUOTES_STARTED', 'QUOTES_DONE', 'BEST_CHOSEN'] as const) await money.advance(ERRAND, e, 'test');
  await money.confirmDeal(ERRAND, deal);
  await money.payDeposit(ERRAND);
  await money.handlePayPalEvent(webhooks.captureCompleted('CAP-2', `${ERRAND}-deposit-0`));
});

const state = async () => (await repo.get(ERRAND))!.state;

describe('the pickup by text', () => {
  it('texts the shop the order and the buyer the code, once', async () => {
    expect(await desk.depositPaid(ERRAND)).toBe('pickup scheduled');
    expect(await state()).toBe('awaiting_pickup');
    expect(texts.map((t) => t.to)).toEqual([SHOP, BUYER]);
    expect(texts[0]!.body).toContain('$10.00 deposit sent by PayPal');
    expect(texts[0]!.body).toContain('remaining $24.00');
    expect(texts[0]!.body).not.toContain('4821'); // the shop only learns the code from the buyer
    expect(texts[1]!.body).toContain('Your pickup code is 4821');
    expect(await desk.depositPaid(ERRAND)).toMatch(/^ignored/);
    expect(texts).toHaveLength(2);
  });

  it('captures the balance when the shop texts back the right code', async () => {
    await desk.depositPaid(ERRAND);
    expect(await desk.inbound(SHOP, 'Code is 4821, thanks')).toBe('Legwork: code confirmed, thank you. $24.00 is on its way to you through PayPal.');
    expect(await state()).toBe('settling');
    expect(payments.callsTo('captureAuthorization')[1]!.args).toMatchObject({ amount: usd(2400), finalCapture: true });
    // A second text after it is done finds nothing open.
    expect(await desk.inbound(SHOP, '4821')).toBe('Legwork: there is no pickup waiting for this number.');

    await money.handlePayPalEvent(webhooks.captureCompleted('CAP-4', `${ERRAND}-balance-0`));
    expect(await desk.balancePaid(ERRAND)).toBe('receipt sent');
    expect(texts.at(-1)).toEqual({ to: BUYER, body: 'Legwork: done. You paid $34.00 to Hartley Hardware through PayPal; the other $6.00 of your hold is released.' });
  });

  it('locks after five wrong codes, so four digits cannot be guessed', async () => {
    await desk.depositPaid(ERRAND);
    expect(await desk.inbound(SHOP, 'hello')).toBe('Legwork: reply with the 4-digit code the customer gives you at pickup.');
    for (let i = 4; i >= 1; i--) expect(await desk.inbound(SHOP, '1111')).toBe(`Legwork: that code does not match. ${i} ${i === 1 ? 'try' : 'tries'} left.`);
    expect(await desk.inbound(SHOP, '2222')).toMatch(/A person from Legwork will contact you/);
    expect(await desk.inbound(SHOP, '4821')).toBe('Legwork: there is no pickup waiting for this number.'); // locked: even the right code
    expect(await state()).toBe('awaiting_pickup');
  });

  it('answers numbers it has no pickup for, and texts no shop without consent', async () => {
    expect(await desk.inbound('+19999999999', '4821')).toBe('Legwork: there is no pickup waiting for this number.');
    const quiet = new PickupDesk({
      money,
      errands: repo,
      plans: { getPlan: async () => plan },
      store: new MemoryPickupStore(),
      sms: { send: async (to, body) => texts.push({ to, body }) },
      canText: (_to, who) => who === 'buyer',
    });
    texts = [];
    await quiet.depositPaid(ERRAND);
    expect(texts.map((t) => t.to)).toEqual([BUYER]);
  });
});
