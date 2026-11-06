import Fastify, { type FastifyInstance } from 'fastify';
import { parseWebhookEvent, type HeaderBag, type WebhookEvent } from '@legwork/paypal';
import type { EventStore } from './events';
import { registerElevenLabsWebhook, registerVoiceTools, type VoiceDeps } from './voice';

/**
 * Runs work after the reply is sent. On a long-running server that is
 * setImmediate; on Vercel it is waitUntil, or the function is frozen as soon
 * as the response ends. The task handles its own errors.
 */
export type Background = (task: () => Promise<void>) => void;

export const nextTick: Background = (task) => {
  setImmediate(() => void task());
};

export interface ServerDeps {
  /** Checks a PayPal delivery's signature (verifyWebhookSignature bound to the client and webhook id). */
  verifyPayPal: (headers: HeaderBag, rawBody: string) => Promise<boolean>;
  events: EventStore;
  /** Runs after the 200 is sent; failures are logged, and PayPal's own retries cover lost deliveries. */
  onPayPalEvent: (event: WebhookEvent) => Promise<void>;
  /** The voice agent's tools and ElevenLabs' post-call webhook; off until ElevenLabs is configured. */
  voice?: VoiceDeps;
  background?: Background;
  /** Extra fields for GET /health: what is switched on, never secrets. */
  health?: Record<string, unknown>;
  logger?: boolean;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 1_048_576 });
  const background = deps.background ?? nextTick;

  app.get('/', async () => ({ service: 'Legwork API', health: '/health' }));
  app.get('/health', async () => ({ ok: true, ...deps.health }));

  // The voice agent's tools post ordinary JSON; their auth is the per-call token header.
  if (deps.voice) registerVoiceTools(app, deps.voice, background);

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

      // A copy whose handler never finished is handled again; the orchestrator
      // ignores repeats, so two copies running at once is safe.
      const fresh = await deps.events.claim('paypal', event);
      if (fresh) {
        background(() =>
          deps
            .onPayPalEvent(event)
            .then(() => deps.events.markProcessed('paypal', event.id))
            .catch((err: unknown) => req.log.error({ err, eventId: event.id }, 'PayPal event handler failed; the next delivery retries it')),
        );
      }
      return reply.code(200).send({ ok: true, duplicate: !fresh });
    });

    if (deps.voice) registerElevenLabsWebhook(hooks, deps.voice, deps.events, background);
  });

  return app;
}
