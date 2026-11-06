import type { FastifyInstance } from 'fastify';
import { twiml, verifyTwilioSignature, type PickupDesk } from '@legwork/messaging';
import type { EventStore } from './events';

export interface TwilioDeps {
  authToken: string;
  /** The public base URL Twilio is configured with; the signature covers the full URL. */
  publicUrl: string;
  desk: PickupDesk;
  events: EventStore;
}

/**
 * Texts to the Legwork number: the shop replying with the pickup code. Twilio
 * posts a form; the reply is TwiML, so the shop hears back in the same thread.
 */
export function registerTwilioWebhook(app: FastifyInstance, deps: TwilioDeps): void {
  app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, body));

    scope.post('/webhooks/twilio/sms', async (req, reply) => {
      const params = Object.fromEntries(new URLSearchParams(typeof req.body === 'string' ? req.body : ''));
      const signature = req.headers['x-twilio-signature'];
      if (!verifyTwilioSignature(deps.authToken, `${deps.publicUrl}${req.url}`, params, typeof signature === 'string' ? signature : undefined)) {
        return reply.code(403).send({ ok: false, error: 'signature' });
      }
      const from = params.From ?? '';
      const sid = params.MessageSid ?? params.SmsSid ?? '';
      const fresh = sid ? await deps.events.claim('twilio', { id: sid, event_type: 'sms.inbound', resource: { from } }) : true;
      let answer: string | undefined;
      if (fresh) {
        answer = await deps.desk.inbound(from, params.Body ?? '');
        if (sid) await deps.events.markProcessed('twilio', sid);
        req.log.info({ from, sid, answer }, 'text from a shop');
      }
      return reply.type('text/xml').send(twiml(answer));
    });
  });
}
