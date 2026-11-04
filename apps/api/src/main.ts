import { PayPalClient, verifyWebhookSignature, type PayPalEnv } from '@legwork/paypal';
import { MemoryEventStore } from './events';
import { buildServer } from './server';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return value;
}

const paypal = new PayPalClient({
  clientId: required('PAYPAL_CLIENT_ID'),
  clientSecret: required('PAYPAL_CLIENT_SECRET'),
  env: (process.env.PAYPAL_ENV as PayPalEnv | undefined) ?? 'sandbox',
});
const webhookId = required('PAYPAL_WEBHOOK_ID');

// The Postgres event store and the orchestrator arrive in the next build step;
// until then events are logged and kept in memory.
const app = buildServer({
  logger: true,
  verifyPayPal: (headers, rawBody) => verifyWebhookSignature(paypal, { headers, rawBody, webhookId }),
  events: new MemoryEventStore(),
  onPayPalEvent: async (event) => {
    app.log.info({ id: event.id, type: event.event_type }, 'PayPal event');
  },
});

const port = Number(process.env.PORT ?? 3001);
app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
