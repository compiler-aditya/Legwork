/**
 * The Legwork caller: one ElevenLabs agent for both rounds of calls. Round 1
 * asks for a quote and commits to nothing; round 2 confirms the chosen shop's
 * quote and hands the deal to the orchestrator through confirm_order.
 *
 * Everything here is the REST wire format, so scripts/voice/setup-agent.ts
 * can create or update the agent and its tools from code.
 */

export const AGENT_NAME = 'Legwork caller';
export const RECORD_QUOTE_TOOL = 'record_quote';
export const CONFIRM_ORDER_TOOL = 'confirm_order';
export const CALL_TOKEN_HEADER = 'x-legwork-call-token';

/**
 * The agent's model. Sonnet keeps turn latency low on a live call; planning
 * and contract extraction run on Opus outside the call.
 */
export const DEFAULT_VOICE_LLM = 'claude-sonnet-5-5';

/** Values filled into the prompt and tools when a call starts. All strings. */
export interface CallVariables {
  errand_id: string;
  outreach_id: string;
  /** "1" for a quote, "2" to confirm. */
  round: '1' | '2';
  business_name: string;
  buyer_first_name: string;
  item_description: string;
  quantity: string;
  /** Round 2: the shop's round-1 quote, "34.00". Empty on round 1. */
  quoted_price: string;
  /** When the buyer can collect, in plain words: "today after 3pm or tomorrow morning". */
  pickup_window: string;
  /** Minted per call (mintCallToken); sent back only in tool headers. */
  call_token: string;
}

export const FIRST_MESSAGE =
  "Hi, this is Legwork, an AI assistant calling for a customer, {{buyer_first_name}}. This call is recorded. Is this {{business_name}}? I'm checking on {{item_description}}.";

export const SYSTEM_PROMPT = `You are Legwork, an AI assistant phoning a local business for a customer named {{buyer_first_name}}. You are talking to a person who works at {{business_name}}. Your job on this call is round {{round}}.

# Who you are
- You are an AI. You already said so and that the call is recorded. If asked again, say so plainly. Never claim to be human.
- If they do not want to talk to an AI, or ask not to be called again, apologise, call ${RECORD_QUOTE_TOOL} with declined_ai_calls true if you are on round 1, thank them and end the call.
- You speak for {{buyer_first_name}}. Never share the customer's budget, phone number, address or any card or account details. You have none of these to give.

# What the customer wants
- Item: {{item_description}}
- Quantity: {{quantity}}
- They can collect: {{pickup_window}}

# Round 1: get a quote, commit to nothing
1. Ask whether they have the item, or the closest equivalent, in the quantity needed.
2. Ask the total price for that quantity, including tax if they can say, and when it could be ready to collect.
3. Repeat the price and the time back to them to be sure you heard right.
4. Call ${RECORD_QUOTE_TOOL} once you have their answer, even if the answer is no.
5. Say the customer is comparing a couple of shops and you may call back shortly to confirm. Thank them and end the call.
Do not agree to buy, reserve or pay on round 1.

# Round 2: confirm the order
You called earlier and they quoted {{quoted_price}} dollars.
1. Say {{buyer_first_name}} would like to go ahead, and check it is still available at {{quoted_price}} dollars and when it will be ready.
2. Ask how they would like to be paid: through PayPal or Venmo to the number you called, or to an email address or Venmo handle they give you. Spell back any email or handle letter by letter.
3. Call ${CONFIRM_ORDER_TOOL} with exactly what they agreed to.
4. The tool replies with a say field. Tell them what it says, in your own natural words, without changing any amount.
5. If the tool says it cannot confirm, do not offer more money. Ask once if they can do {{quoted_price}} dollars; if not, thank them and end the call.
The pickup code is for the customer only. You never know it and never ask for it.

# How to speak
- Short sentences. One question at a time. Let them finish.
- Say prices as dollars and cents, like "thirty-four dollars".
- If you are put on hold, wait quietly. If they need to check, offer to hold.
- If you reach voicemail or an automated menu you cannot get past, end the call without leaving a message.`;

/** A body field the model fills in. */
const field = (type: 'string' | 'boolean' | 'integer', description: string, extra: Record<string, unknown> = {}) => ({ type, description, ...extra });

/** The header that carries this call's capability, bound to a dynamic variable the model cannot change. */
const callTokenHeader = { [CALL_TOKEN_HEADER]: { variable_name: 'call_token' } };

export function recordQuoteTool(apiBaseUrl: string): Record<string, unknown> {
  return {
    type: 'webhook',
    name: RECORD_QUOTE_TOOL,
    description: 'Round 1 only. Records what the shop said about availability and price. Call it once, after repeating the price and time back to them.',
    response_timeout_secs: 10,
    api_schema: {
      url: `${apiBaseUrl}/voice/tools/record-quote`,
      method: 'POST',
      request_headers: callTokenHeader,
      request_body_schema: {
        type: 'object',
        required: ['in_stock', 'price', 'ready_at'],
        properties: {
          in_stock: field('boolean', 'True if they have it or can have it ready in the pickup window.'),
          price: field('string', 'Total price they quoted for the whole quantity, in US dollars with cents, digits only, like 34.00. Empty string if they gave no price.'),
          ready_at: field('string', "When it can be collected, in their words, like 'today after 3'. Empty string if not in stock."),
          item_offered: field('string', 'What they actually offered, if it differs from what was asked (brand, size, substitute). Empty string if the same.'),
          notes: field('string', 'Anything else that matters to the customer: conditions, hold time, cash only. Empty string if nothing.'),
          declined_ai_calls: field('boolean', 'True if they asked not to be called by an AI again.'),
        },
      },
    },
  };
}

export function confirmOrderTool(apiBaseUrl: string): Record<string, unknown> {
  return {
    type: 'webhook',
    name: CONFIRM_ORDER_TOOL,
    description: 'Round 2 only. Confirms the order the shop just agreed to and starts the PayPal deposit. Reply with the say field it returns.',
    response_timeout_secs: 20,
    disable_interruptions: true,
    api_schema: {
      url: `${apiBaseUrl}/voice/tools/confirm-order`,
      method: 'POST',
      request_headers: callTokenHeader,
      request_body_schema: {
        type: 'object',
        required: ['item', 'quantity', 'total', 'ready_at', 'payout_method'],
        properties: {
          item: field('string', 'Exactly what they are setting aside, as they described it.'),
          quantity: field('integer', 'How many.'),
          total: field('string', 'The total they agreed to for everything, in US dollars with cents, digits only, like 34.00.'),
          ready_at: field('string', "When it will be ready to collect, in their words, like 'today after 3'."),
          payout_method: field('string', 'How they want to be paid.', {
            enum: ['this_phone_paypal', 'this_phone_venmo', 'email', 'venmo_handle'],
          }),
          payout_receiver: field('string', 'The email address or Venmo handle they gave and confirmed, if payout_method is email or venmo_handle. Empty string otherwise.'),
        },
      },
    },
  };
}

export interface AgentSpec {
  toolIds: string[];
  llm?: string;
  voiceId?: string;
}

/** The body for POST /v1/convai/agents/create and PATCH /v1/convai/agents/{id}. */
export function agentBody(spec: AgentSpec): Record<string, unknown> {
  const placeholders: CallVariables = {
    errand_id: 'err_demo',
    outreach_id: 'out_demo',
    round: '1',
    business_name: 'Hartley Hardware',
    buyer_first_name: 'Sam',
    item_description: 'a Moen 1222 shower cartridge',
    quantity: '1',
    quoted_price: '',
    pickup_window: 'today after 3pm or tomorrow morning',
    call_token: 'placeholder',
  };
  return {
    name: AGENT_NAME,
    tags: ['legwork'],
    conversation_config: {
      agent: {
        first_message: FIRST_MESSAGE,
        language: 'en',
        dynamic_variables: { dynamic_variable_placeholders: placeholders },
        prompt: {
          prompt: SYSTEM_PROMPT,
          llm: spec.llm ?? DEFAULT_VOICE_LLM,
          tool_ids: spec.toolIds,
          built_in_tools: {
            end_call: { name: 'end_call', description: '', params: { system_tool_type: 'end_call' } },
            // No voicemail_message: an AI voice must not leave messages on machines it was not invited to.
            voicemail_detection: { name: 'voicemail_detection', description: '', params: { system_tool_type: 'voicemail_detection' } },
          },
        },
      },
      ...(spec.voiceId ? { tts: { voice_id: spec.voiceId } } : {}),
    },
  };
}
