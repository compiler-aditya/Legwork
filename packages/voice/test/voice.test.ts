import { describe, expect, it } from 'vitest';
import { usd } from '@legwork/core';
import {
  CALL_TOKEN_HEADER,
  ConfirmOrderSchema,
  ElevenLabsApiError,
  ElevenLabsClient,
  FIRST_MESSAGE,
  SYSTEM_PROMPT,
  ToolInputError,
  agentBody,
  confirmOrderTool,
  mintCallToken,
  parsePostCall,
  postCallEventId,
  recordQuoteTool,
  signElevenLabsBody,
  toDeal,
  transcriptText,
  verifyCallToken,
  verifyElevenLabsSignature,
  type CallClaims,
} from '../src';

const SECRET = 'whsec_test_0123456789abcdef';
const TOKEN_SECRET = 'call-token-secret-of-at-least-32-chars!';
const NOW = Date.parse('2026-11-08T23:00:00Z');

describe('ElevenLabs webhook signatures', () => {
  const body = '{"type":"post_call_transcription","data":{"conversation_id":"conv_1"}}';

  it('accepts what ElevenLabs signs and nothing else', () => {
    const header = signElevenLabsBody(body, SECRET, NOW);
    expect(header).toMatch(/^t=\d+,v0=[0-9a-f]{64}$/);
    expect(verifyElevenLabsSignature(body, header, SECRET, NOW)).toBe(true);
    expect(verifyElevenLabsSignature(body, header.replace(',', ', '), SECRET, NOW)).toBe(true);
    expect(verifyElevenLabsSignature(body + ' ', header, SECRET, NOW)).toBe(false);
    expect(verifyElevenLabsSignature(body, header, 'another-secret', NOW)).toBe(false);
    expect(verifyElevenLabsSignature(body, undefined, SECRET, NOW)).toBe(false);
    expect(verifyElevenLabsSignature(body, 'v0=abc', SECRET, NOW)).toBe(false);
  });

  it('refuses deliveries older or newer than 30 minutes', () => {
    const header = signElevenLabsBody(body, SECRET, NOW);
    expect(verifyElevenLabsSignature(body, header, SECRET, NOW + 29 * 60_000)).toBe(true);
    expect(verifyElevenLabsSignature(body, header, SECRET, NOW + 31 * 60_000)).toBe(false);
    expect(verifyElevenLabsSignature(body, header, SECRET, NOW - 31 * 60_000)).toBe(false);
  });
});

describe('call tokens', () => {
  const claims = { errandId: 'err_tap1', outreachId: 'out_r2_hartley', businessId: 'biz_hartley', round: 2 as const, dialled: '+14155550123' };

  it('round-trips and expires', () => {
    const token = mintCallToken(TOKEN_SECRET, claims, 60, NOW);
    expect(verifyCallToken(TOKEN_SECRET, token, NOW)).toEqual({ ...claims, exp: NOW / 1000 + 60 });
    expect(verifyCallToken(TOKEN_SECRET, token, NOW + 61_000)).toBeUndefined();
  });

  it('refuses a forged or edited token', () => {
    const token = mintCallToken(TOKEN_SECRET, claims, 60, NOW);
    const [prefix, , mac] = token.split('.');
    const edited = Buffer.from(JSON.stringify({ ...claims, errandId: 'err_someone_else', exp: NOW / 1000 + 60 })).toString('base64url');
    expect(verifyCallToken(TOKEN_SECRET, `${prefix}.${edited}.${mac}`, NOW)).toBeUndefined();
    expect(verifyCallToken('a-different-secret-that-is-long-enough', token, NOW)).toBeUndefined();
    expect(verifyCallToken(TOKEN_SECRET, 'garbage', NOW)).toBeUndefined();
    expect(verifyCallToken(TOKEN_SECRET, undefined, NOW)).toBeUndefined();
    expect(() => mintCallToken('short', claims)).toThrow(/32 characters/);
  });
});

describe('confirm_order input', () => {
  const claims: CallClaims = { errandId: 'err_tap1', outreachId: 'out_r2', businessId: 'biz_hartley', round: 2, dialled: '+14155550123', exp: 0 };
  const input = (over: Record<string, unknown> = {}) =>
    ConfirmOrderSchema.parse({ item: 'Moen 1222 cartridge', quantity: '1', total: '$34', ready_at: 'today after 3', payout_method: 'this_phone_venmo', ...over });

  it('takes the errand, business and payout number from the token, not the model', () => {
    expect(toDeal(claims, input())).toEqual({
      businessId: 'biz_hartley',
      outreachId: 'out_r2',
      item: 'Moen 1222 cartridge',
      quantity: 1,
      total: usd(3400),
      payout: { type: 'PHONE', receiver: '+14155550123', wallet: 'VENMO' },
      pickupAt: 'today after 3',
    });
    // A receiver the model added for a phone payout is ignored.
    expect(toDeal(claims, input({ payout_method: 'this_phone_paypal', payout_receiver: '+19995550000' })).payout).toEqual({ type: 'PHONE', receiver: '+14155550123', wallet: 'PAYPAL' });
  });

  it('reads dollar amounts exactly', () => {
    expect(toDeal(claims, input({ total: '1,234.5' })).total).toEqual(usd(123450));
    expect(toDeal(claims, input({ total: '34.00' })).total).toEqual(usd(3400));
    expect(ConfirmOrderSchema.safeParse({ ...input(), total: 'thirty four' }).success).toBe(false);
    expect(ConfirmOrderSchema.safeParse({ ...input(), total: '34.999' }).success).toBe(false);
    expect(ConfirmOrderSchema.safeParse({ ...input(), quantity: 0 }).success).toBe(false);
  });

  it('checks an email or Venmo handle the shop spelled out', () => {
    expect(toDeal(claims, input({ payout_method: 'email', payout_receiver: 'Owner@Hartley.example' })).payout).toEqual({ type: 'EMAIL', receiver: 'owner@hartley.example', wallet: 'PAYPAL' });
    expect(toDeal(claims, input({ payout_method: 'venmo_handle', payout_receiver: '@hartley-hw' })).payout).toEqual({ type: 'USER_HANDLE', receiver: 'hartley-hw', wallet: 'VENMO' });
    expect(() => toDeal(claims, input({ payout_method: 'email', payout_receiver: 'owner at hartley' }))).toThrow(ToolInputError);
    expect(() => toDeal(claims, input({ payout_method: 'venmo_handle', payout_receiver: '' }))).toThrow(ToolInputError);
  });
});

describe('the caller agent', () => {
  it('discloses that it is an AI and the call is recorded before anything else', () => {
    expect(FIRST_MESSAGE).toMatch(/AI assistant/);
    expect(FIRST_MESSAGE).toMatch(/recorded/);
    expect(SYSTEM_PROMPT).toMatch(/Never claim to be human/);
    expect(SYSTEM_PROMPT).toMatch(/never know it and never ask for it/);
  });

  it('binds the tools to the call token, and lets the model fill only what the shop said', () => {
    for (const tool of [recordQuoteTool('https://api.legwork.test'), confirmOrderTool('https://api.legwork.test')] as any[]) {
      expect(tool.api_schema.url).toMatch(/^https:\/\/api\.legwork\.test\/voice\/tools\//);
      expect(tool.api_schema.request_headers).toEqual({ [CALL_TOKEN_HEADER]: { variable_name: 'call_token' } });
      const fields = Object.keys(tool.api_schema.request_body_schema.properties);
      for (const forbidden of ['errand_id', 'outreach_id', 'business_id', 'phone', 'call_token']) expect(fields).not.toContain(forbidden);
    }
  });

  it('builds the agent body ElevenLabs expects', () => {
    const body = agentBody({ toolIds: ['tool_a', 'tool_b'], voiceId: 'voice_x' }) as any;
    expect(body.conversation_config.agent.prompt).toMatchObject({ llm: 'claude-sonnet-5-5', tool_ids: ['tool_a', 'tool_b'] });
    expect(body.conversation_config.agent.prompt.built_in_tools.voicemail_detection.params).toEqual({ system_tool_type: 'voicemail_detection' });
    expect(body.conversation_config.tts).toEqual({ voice_id: 'voice_x' });
    const placeholders = body.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders;
    for (const name of SYSTEM_PROMPT.match(/\{\{(\w+)\}\}/g)!.map((m) => m.slice(2, -2))) expect(placeholders).toHaveProperty(name);
  });
});

describe('ElevenLabsClient', () => {
  function fakeFetch(status: number, body: unknown) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
  }

  it('places an outbound call with the call variables', async () => {
    const { calls, fetch } = fakeFetch(200, { success: true, message: 'ok', conversation_id: 'conv_9', callSid: 'CA9' });
    const client = new ElevenLabsClient({ apiKey: 'xi_key', fetch });
    const result = await client.outboundCall({ agentId: 'agent_1', agentPhoneNumberId: 'phnum_1', toNumber: '+14155550123', dynamicVariables: { round: '1', call_token: 't' } });
    expect(result).toEqual({ conversationId: 'conv_9', callSid: 'CA9' });
    expect(calls[0]!.url).toBe('https://api.elevenlabs.io/v1/convai/twilio/outbound-call');
    expect((calls[0]!.init.headers as Record<string, string>)['xi-api-key']).toBe('xi_key');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      agent_id: 'agent_1',
      agent_phone_number_id: 'phnum_1',
      to_number: '+14155550123',
      conversation_initiation_client_data: { dynamic_variables: { round: '1', call_token: 't' } },
    });
  });

  it('reports a call ElevenLabs did not place, and API errors with their detail', async () => {
    const declined = new ElevenLabsClient({ apiKey: 'k', fetch: fakeFetch(200, { success: false, message: 'Number is not verified', conversation_id: null }).fetch });
    await expect(declined.outboundCall({ agentId: 'a', agentPhoneNumberId: 'p', toNumber: '+14155550123', dynamicVariables: {} })).rejects.toThrow(/Number is not verified/);
    const invalid = new ElevenLabsClient({ apiKey: 'k', fetch: fakeFetch(422, { detail: [{ loc: ['body', 'to_number'], msg: 'invalid' }] }).fetch });
    const err = await invalid.getAgent('agent_1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ElevenLabsApiError);
    expect((err as ElevenLabsApiError).status).toBe(422);
    await expect(declined.outboundCall({ agentId: 'a', agentPhoneNumberId: 'p', toNumber: '415-555-0123', dynamicVariables: {} })).rejects.toThrow(/E\.164/);
  });
});

describe('post-call webhooks', () => {
  const transcription = {
    type: 'post_call_transcription',
    event_timestamp: 1_794_000_000,
    data: {
      agent_id: 'agent_1',
      conversation_id: 'conv_r2',
      status: 'done',
      transcript: [
        { role: 'agent', message: "Hi, this is Legwork, an AI assistant calling for a customer, Sam. This call is recorded.", time_in_call_secs: 0 },
        { role: 'user', message: 'Hartley Hardware, yeah.', time_in_call_secs: 6 },
        { role: 'user', message: "Thirty-four even, I'll have it at the counter after three.", time_in_call_secs: 71 },
        {
          role: 'agent',
          message: null,
          time_in_call_secs: 75,
          tool_calls: [{ request_id: 'r1', tool_name: 'confirm_order', params_as_json: '{"item":"Moen 1222","quantity":1,"total":"34.00"}', tool_has_been_called: true }],
        },
        { role: 'agent', message: 'Confirmed.', time_in_call_secs: 77 },
      ],
      metadata: { call_duration_secs: 92 },
      analysis: { transcript_summary: 'Shop confirmed the cartridge for $34.', call_successful: 'success' },
      conversation_initiation_client_data: { dynamic_variables: { errand_id: 'err_tap1', outreach_id: 'out_r2_hartley', round: '2', call_token: 'lwc1.x.y' } },
    },
  };

  it('numbers the spoken lines and keeps tool calls next to them', () => {
    const report = parsePostCall(JSON.stringify(transcription));
    expect(report).toMatchObject({ kind: 'transcript', conversationId: 'conv_r2', errandId: 'err_tap1', outreachId: 'out_r2_hartley', round: 2, durationSecs: 92, callSuccessful: 'success' });
    if (report.kind !== 'transcript') throw new Error('expected a transcript');
    expect(report.lines.map((l) => [l.line, l.at, l.speaker])).toEqual([
      [0, '0:00', 'agent'],
      [1, '0:06', 'shop'],
      [2, '1:11', 'shop'],
      [3, '1:17', 'agent'],
    ]);
    expect(report.toolCalls).toEqual([{ name: 'confirm_order', params: { item: 'Moen 1222', quantity: 1, total: '34.00' }, at: '1:15', afterLine: 2 }]);
    expect(transcriptText(report.lines).split('\n')[2]).toBe("[2] 1:11 Shop: Thirty-four even, I'll have it at the counter after three.");
    expect(postCallEventId(transcription)).toBe('post_call_transcription:conv_r2');
  });

  it('reports calls that never connected, and ignores audio', () => {
    expect(parsePostCall(JSON.stringify({ type: 'call_initiation_failure', data: { agent_id: 'a', conversation_id: 'c', failure_reason: 'no-answer', conversation_initiation_client_data: { dynamic_variables: { outreach_id: 'out_1' } } } }))).toEqual({
      kind: 'not_connected',
      conversationId: 'c',
      agentId: 'a',
      reason: 'no-answer',
      outreachId: 'out_1',
    });
    expect(parsePostCall(JSON.stringify({ type: 'post_call_audio', data: { conversation_id: 'c', full_audio: 'AAAA' } }))).toEqual({ kind: 'ignored', type: 'post_call_audio', conversationId: 'c' });
    expect(() => parsePostCall('not json')).toThrow();
    expect(() => parsePostCall('{"type":"post_call_transcription","data":{}}')).toThrow(/conversation_id/);
  });
});
