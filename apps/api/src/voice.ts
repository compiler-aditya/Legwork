import type { FastifyInstance } from 'fastify';
import { subtract, type Money } from '@legwork/core';
import type { ConfirmResult, Deal, PayoutTarget } from '@legwork/orchestrator';
import {
  CALL_TOKEN_HEADER,
  ConfirmOrderSchema,
  PostCallPayloadError,
  RecordQuoteSchema,
  ToolInputError,
  parsePostCall,
  postCallEventId,
  spoken,
  toDeal,
  toQuote,
  verifyCallToken,
  verifyElevenLabsSignature,
  type CallClaims,
  type CallReport,
  type Quote,
} from '@legwork/voice';
import type { EventStore } from './events';
import type { Background } from './server';

export interface VoiceDeps {
  /** Signs per-call tokens (CALL_TOKEN_SECRET). */
  callTokenSecret: string;
  /** The post-call webhook's HMAC secret from ElevenLabs (ELEVENLABS_WEBHOOK_SECRET). */
  webhookSecret: string;
  recordQuote(claims: CallClaims, quote: Quote): Promise<void>;
  /** ErrandMoney.confirmDeal for the token's errand. */
  confirmOrder(claims: CallClaims, deal: Deal): Promise<ConfirmResult>;
  /** Runs after the agent has its answer: captures the deposit. Failures are logged. */
  afterConfirm(claims: CallClaims): Promise<void>;
  onCallReport(report: CallReport): Promise<void>;
}

/** What the agent hears back. `say` is the line it relays; it never contains the pickup code. */
interface ToolReply {
  ok: boolean;
  say: string;
}

/** The agent's tools, called mid-call by ElevenLabs. */
export function registerVoiceTools(app: FastifyInstance, deps: VoiceDeps, background: Background): void {
  const claimsOf = (headers: Record<string, unknown>): CallClaims | undefined => {
    const raw = headers[CALL_TOKEN_HEADER];
    return verifyCallToken(deps.callTokenSecret, typeof raw === 'string' ? raw : undefined);
  };

  app.post('/voice/tools/record-quote', async (req, reply) => {
    const claims = claimsOf(req.headers);
    if (!claims) return reply.code(401).send({ ok: false, say: 'Something went wrong on my side. Thank them and end the call.' });
    const parsed = RecordQuoteSchema.safeParse(req.body);
    if (!parsed.success) return reply.send(retry(parsed.error.issues[0]?.path.join('.') ?? 'the answer'));
    await deps.recordQuote(claims, toQuote(parsed.data));
    const answer: ToolReply = parsed.data.declined_ai_calls
      ? { ok: true, say: 'Noted. Apologise for the call, thank them and end the call.' }
      : { ok: true, say: 'Got it. Say the customer is comparing a couple of shops and you may call back shortly to confirm. Thank them and end the call.' };
    return reply.send(answer);
  });

  app.post('/voice/tools/confirm-order', async (req, reply) => {
    const claims = claimsOf(req.headers);
    if (!claims) return reply.code(401).send({ ok: false, say: 'Something went wrong on my side. Thank them and end the call.' });
    if (claims.round !== 2) return reply.send({ ok: false, say: 'This call is only for a quote. Do not confirm anything; say you may call back.' } satisfies ToolReply);
    const parsed = ConfirmOrderSchema.safeParse(req.body);
    if (!parsed.success) return reply.send(retry(parsed.error.issues[0]?.path.join('.') ?? 'the order'));

    let deal: Deal;
    try {
      deal = toDeal(claims, parsed.data);
    } catch (err) {
      if (err instanceof ToolInputError) return reply.send({ ok: false, say: `I could not confirm yet: ${err.message}.` } satisfies ToolReply);
      throw err;
    }
    const result = await deps.confirmOrder(claims, deal);
    if (!result.ok) {
      req.log.info({ errandId: claims.errandId, reason: result.reason }, 'confirm_order refused');
      return reply.send({ ok: false, say: `I can't confirm that order: ${result.reason}.` } satisfies ToolReply);
    }

    background(() => deps.afterConfirm(claims).catch((err: unknown) => req.log.error({ err, errandId: claims.errandId }, 'deposit after confirm_order failed')));
    return reply.send(confirmedReply(deal, result.deposit));
  });
}

/** ElevenLabs' post-call webhook. Register inside a scope that keeps JSON bodies raw, for the signature. */
export function registerElevenLabsWebhook(app: FastifyInstance, deps: VoiceDeps, events: EventStore, background: Background): void {
  app.post('/webhooks/elevenlabs', { bodyLimit: 5 * 1_048_576 }, async (req, reply) => {
    const rawBody = typeof req.body === 'string' ? req.body : '';
    const signature = req.headers['elevenlabs-signature'];
    if (!verifyElevenLabsSignature(rawBody, typeof signature === 'string' ? signature : undefined, deps.webhookSecret)) {
      return reply.code(401).send({ ok: false, error: 'signature' });
    }
    let report: CallReport;
    try {
      report = parsePostCall(rawBody);
    } catch (err) {
      if (err instanceof PostCallPayloadError) return reply.code(400).send({ ok: false, error: err.message });
      throw err;
    }
    const payload = JSON.parse(rawBody) as { type?: string; data?: { conversation_id?: string } };
    const event = { id: postCallEventId(payload), event_type: String(payload.type), resource: { conversation_id: payload.data?.conversation_id } };
    const fresh = await events.claim('elevenlabs', event);
    if (fresh && report.kind !== 'ignored') {
      background(() =>
        deps
          .onCallReport(report)
          .then(() => events.markProcessed('elevenlabs', event.id))
          .catch((err: unknown) => req.log.error({ err, eventId: event.id }, 'post-call handler failed; the next delivery retries it')),
      );
    }
    return reply.send({ ok: true, duplicate: !fresh });
  });
}

function retry(field: string): ToolReply {
  return { ok: false, say: `I did not get ${field} clearly. Ask them again, then call the tool again.` };
}

function confirmedReply(deal: Deal, deposit: Money): ToolReply {
  const balance = subtract(deal.total, deposit);
  const depositLine =
    deposit.cents > 0
      ? `A deposit of ${spoken(deposit)} is on its way to them now through PayPal, ${destination(deal.payout)}.`
      : 'There is no deposit on this one.';
  return {
    ok: true,
    say:
      `Confirmed: ${deal.quantity} of ${deal.item} for ${spoken(deal.total)}, ready ${deal.pickupAt ?? 'as agreed'}. ${depositLine} ` +
      `When the customer collects, they will give a four-digit pickup code. Text that code back to the number I'm calling from, ` +
      `and the remaining ${spoken(balance)} is sent straight away. Thank them and end the call.`,
  };
}

function destination(p: PayoutTarget): string {
  if (p.type === 'PHONE') return p.wallet === 'PAYPAL' ? 'to the PayPal account on this phone number' : 'to the Venmo account on this phone number';
  if (p.type === 'EMAIL') return `to ${p.receiver}`;
  return `to Venmo at ${p.receiver}`;
}
