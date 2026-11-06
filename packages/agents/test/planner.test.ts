import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { usd } from '@legwork/core';
import { MemoryShopDirectory, PLANNER_SYSTEM, Planner, PlannerError, type ProductFinder } from '../src';

/** A real SDK client whose HTTP calls get scripted Claude turns, so the real tool runner runs. */
function scripted(turns: Array<Array<Record<string, unknown>>>) {
  const requests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  let n = 0;
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    requests.push({ url: String(url), headers, body: JSON.parse(String(init.body)) });
    const content = turns[n++];
    if (!content) throw new Error('No more scripted turns');
    const toolUse = content.some((b) => b.type === 'tool_use');
    return new Response(
      JSON.stringify({ id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: toolUse ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof globalThis.fetch;
  const client = new Anthropic({ apiKey: 'test-key', fetch, maxRetries: 0 });
  return { client, requests };
}
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });

const HOME = { lat: 37.7599, lon: -122.4148, label: 'Mission District, San Francisco' };
const shops = new MemoryShopDirectory([
  { businessId: 'biz_hartley', name: 'Hartley Hardware', phone: '+14155550101', categories: ['hardware', 'plumbing'], acceptsAiCalls: true, reliability: 0.9, lat: 37.7612, lon: -122.4195 },
  { businessId: 'biz_corner', name: 'Corner Plumbing Supply', phone: '+14155550102', categories: ['plumbing supply'], acceptsAiCalls: true, reliability: 0.7, lat: 37.7650, lon: -122.4100 },
  { businessId: 'biz_noai', name: 'No Robots Hardware', phone: '+14155550103', categories: ['hardware', 'plumbing'], acceptsAiCalls: false, reliability: 0.8, lat: 37.7605, lon: -122.4150 },
  { businessId: 'biz_bakery', name: 'Tartine', phone: '+14155550104', categories: ['bakery'], acceptsAiCalls: true, reliability: 0.9, lat: 37.7614, lon: -122.4241 },
  { businessId: 'biz_far', name: 'Oakland Ace', phone: '+15105550105', categories: ['hardware', 'plumbing'], acceptsAiCalls: true, reliability: 0.9, lat: 37.8044, lon: -122.2712 },
]);
const products: ProductFinder = {
  search: async () => [
    { id: 'p_moen1222', title: 'Moen 1222 Posi-Temp Cartridge', brand: 'Moen', price: usd(3100), merchant: 'homedepot.com', url: 'https://www.homedepot.com/p/1' },
    { id: 'p_moen1225', title: 'Moen 1225 Cartridge', brand: 'Moen', price: usd(2700), merchant: 'amazon.com' },
  ],
  searchByImage: async () => [{ id: 'p_moen1222', title: 'Moen 1222 Posi-Temp Cartridge', brand: 'Moen', price: usd(3100), merchant: 'homedepot.com' }],
};
const request = { text: 'My shower drips. I think it needs a Moen 1222 cartridge, today if possible.', budgetMax: usd(4000), location: HOME, pickupWindow: 'today after 3pm' };

describe('Planner', () => {
  it('identifies the item, finds shops, fixes a rejected plan, and returns phones and prices from the tools', async () => {
    const { client, requests } = scripted([
      [use('t1', 'identify_product', { query: 'Moen 1222 cartridge', use_photo: false })],
      [use('t2', 'find_shops', { what: 'plumbing hardware', radius_km: 8 })],
      // First try names a shop that refuses AI calls and an invented one: refused.
      [use('t3', 'submit_plan', { item_description: 'a Moen 1222 shower cartridge', quantity: 1, pickup_window: 'today after 3pm', shop_ids: ['biz_hartley', 'biz_noai', 'biz_made_up'], benchmark_product_id: 'p_moen1222', reasoning: 'x' })],
      [use('t4', 'submit_plan', { item_description: 'a Moen 1222 shower cartridge', quantity: 1, pickup_window: 'today after 3pm', shop_ids: ['biz_hartley', 'biz_corner'], benchmark_product_id: 'p_moen1222', reasoning: 'Two plumbing shops within a mile; Home Depot sells it for $31 online.' })],
      [{ type: 'text', text: 'Done.' }],
    ]);
    const result = await new Planner(client.beta.messages, { products, shops }).plan(request);

    expect(result).toEqual({
      kind: 'plan',
      item: 'a Moen 1222 shower cartridge',
      quantity: 1,
      pickupWindow: 'today after 3pm',
      shops: [
        { businessId: 'biz_hartley', name: 'Hartley Hardware', phone: '+14155550101' },
        { businessId: 'biz_corner', name: 'Corner Plumbing Supply', phone: '+14155550102' },
      ],
      benchmark: { price: usd(3100), source: 'homedepot.com (Channel3)', url: 'https://www.homedepot.com/p/1', productId: 'p_moen1222', title: 'Moen 1222 Posi-Temp Cartridge' },
      reasoning: 'Two plumbing shops within a mile; Home Depot sells it for $31 online.',
    });

    // The request: Opus 5.5 at high effort, server-side fallbacks, a cached system prompt, four tools.
    const first = requests[0]!;
    expect(first.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(first.body).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    expect(first.body.system).toEqual([{ type: 'text', text: PLANNER_SYSTEM, cache_control: { type: 'ephemeral' } }]);
    expect(first.body.tools.map((t: { name: string }) => t.name)).toEqual(['identify_product', 'find_shops', 'submit_plan', 'ask_buyer']);
    expect(first.body.tool_choice).toBeUndefined();

    // The shop list the model saw: no phone numbers, the far shop and the bakery ranked out or last.
    const shopResult = JSON.parse(requests[2]!.body.messages.at(-1).content[0].content);
    expect(shopResult.map((s: { id: string }) => s.id)).not.toContain('biz_far');
    expect(JSON.stringify(shopResult)).not.toContain('+1415');
    expect(shopResult.find((s: { id: string }) => s.id === 'biz_noai').callable).toBe(false);

    // The rejected plan went back as an error naming both problems.
    const rejected = requests[3]!.body.messages.at(-1).content[0];
    expect(rejected.is_error).toBe(true);
    expect(JSON.stringify(rejected.content)).toMatch(/No Robots Hardware cannot be called.*biz_made_up was not returned by find_shops/);
  });

  it('shows the model the photo and can search with it', async () => {
    const { client, requests } = scripted([
      [use('t1', 'identify_product', { query: 'shower cartridge', use_photo: true })],
      [use('t2', 'ask_buyer', { question: 'Is it the hot and cold handle, or the shower head itself?' })],
      [{ type: 'text', text: 'Asked.' }],
    ]);
    const result = await new Planner(client.beta.messages, { products, shops }).plan({ ...request, photoUrl: 'https://img.legwork.test/tap.jpg' });
    expect(result).toEqual({ kind: 'question', question: 'Is it the hot and cold handle, or the shower head itself?' });
    expect(requests[0]!.body.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'url', url: 'https://img.legwork.test/tap.jpg' } });
    expect(JSON.parse(requests[1]!.body.messages.at(-1).content[0].content)).toEqual([{ id: 'p_moen1222', title: 'Moen 1222 Posi-Temp Cartridge', brand: 'Moen', price_usd: '31.00', merchant: 'homedepot.com' }]);
  });

  it('plans without an online price when there is no product search, and fails when it never submits', async () => {
    const noPlan = scripted([[use('t1', 'identify_product', { query: 'bagels', use_photo: false })], [{ type: 'text', text: 'I could not decide.' }]]);
    await expect(new Planner(noPlan.client.beta.messages, { shops }).plan(request)).rejects.toThrow(PlannerError);
    expect(noPlan.requests[1]!.body.messages.at(-1).content[0].content).toMatch(/Product search is not available/);
  });
});
