import Fastify, { type FastifyInstance } from 'fastify';
import { parseWebhookEvent, type HeaderBag, type WebhookEvent } from '@legwork/paypal';
import type { EventStore } from './events';

export interface ServerDeps {
  /** Checks a PayPal delivery's signature (verifyWebhookSignature bound to the client and webhook id). */
  verifyPayPal: (headers: HeaderBag, rawBody: string) => Promise<boolean>;
  events: EventStore;
  /** Runs after the 200 is sent; failures are logged, and PayPal's own retries cover lost deliveries. */
  onPayPalEvent: (event: WebhookEvent) => Promise<void>;
  logger?: boolean;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 1_048_576 });

  app.get('/health', async () => ({ ok: true }));

  // Webhook routes need the body exactly as sent, so they parse JSON as a raw string.
  app.register(async (hooks) => {
    hooks.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

    hooks.post('/webhooks/paypal', async (req, reply) => {
      const rawBody = typeof req.body === 'string' ? req.body : '';
      let verified = false;
      try {
        verified = await deps.verifyPayPal(req.headers as HeaderBag, rawBody);
      } catch (err) {
        req.log.error({ err }, 'PayPal signature check failed to run');
        // 5xx: PayPal retries, so a delivery is not lost while PayPal's verify endpoint is down.
        return reply.code(503).send({ ok: false });
      }
      if (!verified) return reply.code(400).send({ ok: false, error: 'signature' });

      let event: WebhookEvent;
      try {
        event = parseWebhookEvent(rawBody);
      } catch {
        return reply.code(400).send({ ok: false, error: 'event' });
      }

      const isNew = await deps.events.recordOnce('paypal', event);
      if (isNew) {
        setImmediate(() => {
          deps.onPayPalEvent(event).catch((err: unknown) => req.log.error({ err, eventId: event.id }, 'PayPal event handler failed'));
        });
      }
      return reply.code(200).send({ ok: true, duplicate: !isNew });
    });
  });

  return app;
}
