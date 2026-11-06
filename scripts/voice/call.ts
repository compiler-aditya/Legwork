/**
 * Places one real call with the Legwork caller, to a number whose owner has
 * agreed to take it (your own phone). Use it to hear the agent before
 * calling a shop. The tools reach the API at PUBLIC_API_URL, so deploy first.
 *
 *   npm run voice:call -- --to=+14155550123              round 1: ask for a quote
 *   npm run voice:call -- --to=+14155550123 --round=2 --quoted=34.00 --errand=err_demo
 *
 * Round 2 confirms against a real errand in the API, which must be waiting
 * on the call (state "confirming"); otherwise confirm_order politely refuses.
 */
import { ElevenLabsClient, mintCallToken, type CallVariables } from '@legwork/voice';

try {
  process.loadEnvFile('.env');
} catch {
  // no .env: use the environment as it is
}

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const need = (name: string) => {
  const v = process.env[name];
  if (!v) {
    console.error(`Set ${name} (see .env.example).`);
    process.exit(1);
  }
  return v;
};

const to = arg('to');
if (!to || !/^\+[1-9]\d{6,14}$/.test(to)) {
  console.error('Pass --to=+E164 for a phone whose owner agreed to take a call from an AI.');
  process.exit(1);
}
const round = arg('round') === '2' ? 2 : 1;
const errandId = arg('errand') ?? 'err_demo';
const outreachId = `out_r${round}_${Date.now().toString(36)}`;
const businessId = arg('business') ?? 'biz_demo';

const variables: CallVariables = {
  errand_id: errandId,
  outreach_id: outreachId,
  round: round === 2 ? '2' : '1',
  business_name: arg('shop') ?? 'Hartley Hardware',
  buyer_first_name: arg('buyer') ?? 'Sam',
  item_description: arg('item') ?? 'a Moen 1222 shower cartridge',
  quantity: arg('quantity') ?? '1',
  quoted_price: round === 2 ? (arg('quoted') ?? '34.00') : '',
  offer_price: round === 2 ? (arg('offer') ?? arg('quoted') ?? '34.00') : '',
  pickup_window: arg('pickup') ?? 'today after 3pm or tomorrow morning',
  call_token: mintCallToken(need('CALL_TOKEN_SECRET'), { errandId, outreachId, businessId, round, dialled: to }),
};

const client = new ElevenLabsClient({ apiKey: need('ELEVENLABS_API_KEY') });
const { conversationId, callSid } = await client.outboundCall({
  agentId: need('ELEVENLABS_AGENT_ID'),
  agentPhoneNumberId: need('ELEVENLABS_PHONE_NUMBER_ID'),
  toNumber: to,
  dynamicVariables: { ...variables },
});
console.log(`Calling ${to} (round ${round}). Conversation ${conversationId}${callSid ? `, Twilio call ${callSid}` : ''}.`);
console.log('The transcript arrives at /webhooks/elevenlabs when the call ends.');
