import { describe, expect, it } from 'vitest';
import { needsReview } from '@legwork/core';
import type { TranscriptLine } from '@legwork/voice';
import { ContractExtractor, EXTRACTION_SCHEMA, EXTRACTOR_SYSTEM, ExtractionError, type MessagesApi } from '../src';

const LINES: TranscriptLine[] = [
  { line: 0, at: '0:00', seconds: 0, speaker: 'agent', text: "Hi, this is Legwork, an AI assistant calling for a customer, Sam. This call is recorded." },
  { line: 1, at: '0:06', seconds: 6, speaker: 'shop', text: 'Hartley Hardware, how can I help?' },
  { line: 2, at: '0:31', seconds: 31, speaker: 'agent', text: 'Could you do thirty-one dollars for the Moen 1222 cartridge?' },
  { line: 3, at: '0:40', seconds: 40, speaker: 'shop', text: "Best I can do is $32.00 for the one Moen 1222 cartridge." },
  { line: 4, at: '0:52', seconds: 52, speaker: 'shop', text: "I'll have it at the counter after 3 today." },
];

const reply = (body: unknown, over: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }],
  stop_reason: 'end_turn',
  stop_details: null,
  usage: { input_tokens: 900, output_tokens: 120 },
  ...over,
});

function fake(response: unknown) {
  const requests: Array<Record<string, unknown>> = [];
  const messages = { create: async (params: Record<string, unknown>) => (requests.push(params), response) } as unknown as MessagesApi;
  return { messages, requests };
}

const agreed = {
  agreed: true,
  item: { value: 'Moen 1222 cartridge', line: 3, quote: 'the one Moen 1222 cartridge' },
  quantity: { value: 1, line: 3, quote: 'the one Moen 1222' },
  total: { value: '32.00', line: 3, quote: '$32.00' },
  ready_at: { value: 'today after 3', line: 4, quote: 'at the counter after 3 today' },
  notes: '',
};
const input = { errandId: 'err_tap1', shopId: 'biz_hartley', shopName: 'Hartley Hardware', lines: LINES };
const NOW = () => new Date('2026-11-08T22:00:00Z');

describe('ContractExtractor', () => {
  it('asks for structured terms at low effort, with fallbacks and a cached system prompt', async () => {
    const { messages, requests } = fake(reply(agreed));
    await new ContractExtractor(messages, undefined, NOW).extract({ ...input, recorded: { item: 'Moen 1222 cartridge', quantity: 1, totalCents: 3200 } });
    expect(requests[0]).toMatchObject({
      model: 'claude-opus-5-5',
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: EXTRACTION_SCHEMA } },
      system: [{ type: 'text', text: EXTRACTOR_SYSTEM, cache_control: { type: 'ephemeral' } }],
    });
    const content = (requests[0]!.messages as Array<{ content: string }>)[0]!.content;
    expect(content).toContain('[3] 0:40 Shop: Best I can do is $32.00');
    expect(requests[0]).not.toHaveProperty('tool_choice');
  });

  it('returns terms tied to their lines, hashed, with nothing to review when the tool agrees', async () => {
    const { messages } = fake(reply(agreed));
    const review = await new ContractExtractor(messages, undefined, NOW).extract({ ...input, recorded: { item: 'Moen 1222 cartridge', quantity: 1, totalCents: 3200 } });
    expect(review).toMatchObject({
      agreed: true,
      terms: {
        item: { value: 'Moen 1222 cartridge', line: 3, at: '0:40' },
        totalCents: { value: 3200, line: 3, at: '0:40', quote: '$32.00' },
        readyAt: { value: 'today after 3', line: 4, at: '0:52' },
      },
      mismatches: [],
      unverified: [],
      model: 'claude-opus-5-5',
      reviewedAt: '2026-11-08T22:00:00.000Z',
    });
    expect(review.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(needsReview(review)).toBe(false);
  });

  it('flags a total that disagrees with what the agent recorded', async () => {
    const { messages } = fake(reply(agreed));
    const review = await new ContractExtractor(messages).extract({ ...input, recorded: { item: 'Moen 1222 cartridge', quantity: 1, totalCents: 3400 } });
    expect(review.mismatches).toEqual([{ field: 'totalCents', fromTranscript: 3200, fromTools: 3400 }]);
    expect(needsReview(review)).toBe(true);
  });

  it('flags a quote that is not on the line it cites', async () => {
    const { messages } = fake(reply({ ...agreed, total: { value: '30.00', line: 3, quote: 'thirty dollars even' } }));
    const review = await new ContractExtractor(messages).extract(input);
    expect(review.unverified).toEqual(['totalCents']);
    expect(needsReview(review)).toBe(true);
  });

  it('reports a call where the shop did not agree', async () => {
    const empty = { value: '', line: -1, quote: '' };
    const { messages } = fake(reply({ agreed: false, item: empty, quantity: { value: 0, line: -1, quote: '' }, total: empty, ready_at: empty, notes: 'Sold out until Monday.' }));
    const review = await new ContractExtractor(messages).extract(input);
    expect(review).toMatchObject({ agreed: false, notes: 'Sold out until Monday.', mismatches: [], unverified: [] });
    expect(review.terms).toBeUndefined();
    expect(needsReview(review)).toBe(true);
  });

  it('fails clearly on a refusal, a cut-off answer, or output in the wrong shape', async () => {
    const run = (r: unknown) => new ContractExtractor(fake(r).messages).extract(input);
    await expect(run(reply(agreed, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } }))).rejects.toThrow(/declined.*cyber/);
    await expect(run(reply(agreed, { stop_reason: 'max_tokens' }))).rejects.toThrow(ExtractionError);
    await expect(run(reply('not json'))).rejects.toThrow(/expected shape/);
    await expect(new ContractExtractor(fake(reply(agreed)).messages).extract({ ...input, lines: [] })).rejects.toThrow(/empty/);
  });
});
