import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { FakePayments } from '@legwork/orchestrator/testing';
import { createApp } from '../src/app';

const ADMIN = 'admin-token-for-tests';

/** A real SDK client whose HTTP calls get scripted Claude turns. */
function scriptedClaude(turns: Array<Array<Record<string, unknown>>>) {
  let n = 0;
  const fetch = (async () => {
    const content = turns[n++] ?? [{ type: 'text', text: 'Done.' }];
    const toolUse = content.some((b) => b.type === 'tool_use');
    return new Response(
      JSON.stringify({ id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: toolUse ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof globalThis.fetch;
  return new Anthropic({ apiKey: 'test', fetch, maxRetries: 0 }).beta.messages;
}
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });

async function setup(turns: Array<Array<Record<string, unknown>>>) {
  const payments = new FakePayments();
  const { app } = await createApp({
    env: { LEGWORK_ADMIN_TOKEN: ADMIN, CALL_TOKEN_SECRET: 'call-token-secret-of-at-least-32-chars!', PUBLIC_API_URL: 'https://api.legwork.test' },
    paypal: { payments, verify: async () => true },
    anthropic: scriptedClaude(turns),
    caller: { place: async () => ({ conversationId: 'conv_1' }) },
    logger: false,
  });
  const auth = { authorization: `Bearer ${ADMIN}` };
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: auth, payload: payload as Record<string, unknown> });
  await post('/businesses', { businessId: 'biz_hartley', name: 'Hartley Hardware', phone: '+14155550101', lat: 37.7612, lon: -122.4195, categories: ['hardware', 'plumbing'] });
  await post('/businesses', { businessId: 'biz_corner', name: 'Corner Plumbing Supply', phone: '+14155550102', lat: 37.765, lon: -122.41, categories: ['plumbing supply'] });
  return { app, post, payments };
}

const ask = {
  userId: 'usr_sam',
  userName: 'Sam',
  request: { kind: 'item', text: 'A Moen 1222 cartridge for my shower, today' },
  budgetMaxCents: 4000,
  buyer: { firstName: 'Sam', phone: '+14155559999' },
  location: { lat: 37.7599, lon: -122.4148, label: 'Mission District' },
  pickupWindow: 'today after 3pm',
};

describe('errands planned by Claude', () => {
  it('turns a request into an errand whose calls go to the directory numbers', async () => {
    const t = await setup([
      [use('t1', 'find_shops', { what: 'plumbing hardware', radius_km: 5 })],
      [use('t2', 'submit_plan', { item_description: 'a Moen 1222 shower cartridge', quantity: 1, pickup_window: 'today after 3pm', shop_ids: ['biz_corner', 'biz_hartley'], benchmark_product_id: null, reasoning: 'Two plumbing shops within a mile.' })],
    ]);
    const res = await t.post('/errands', ask);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      ok: true,
      reasoning: 'Two plumbing shops within a mile.',
      plan: {
        item: 'a Moen 1222 shower cartridge',
        buyerFirstName: 'Sam',
        buyerPhone: '+14155559999',
        shops: [
          { businessId: 'biz_corner', name: 'Corner Plumbing Supply', phone: '+14155550102' },
          { businessId: 'biz_hartley', name: 'Hartley Hardware', phone: '+14155550101' },
        ],
      },
    });
    expect(body.approveUrl).toContain('checkoutnow');
    expect(t.payments.callsTo('createHoldOrder')[0]!.args).toMatchObject({ description: 'Legwork: a Moen 1222 shower cartridge, up to $40.00' });
  });

  it('passes the planner question back and creates nothing', async () => {
    const t = await setup([[use('t1', 'ask_buyer', { question: 'Which tap is it: the shower or the kitchen?' })]]);
    const preview = await t.post('/errands/plan', ask);
    expect(preview.json()).toEqual({ ok: true, result: { kind: 'question', question: 'Which tap is it: the shower or the kitchen?' } });
  });

  it('refuses a request with neither a plan nor what the planner needs', async () => {
    const t = await setup([]);
    const { buyer: _b, location: _l, ...bare } = ask;
    expect((await t.post('/errands', bare)).json()).toEqual({ ok: false, error: 'Send a plan, or buyer and location for the planner' });
    expect((await t.post('/errands', { ...ask, photoUrl: 'http://insecure.example/x.jpg' })).statusCode).toBe(400);
  });
});
