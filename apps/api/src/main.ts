import { ErrandMoney, MemoryErrandRepo, paypalPayments } from '@legwork/orchestrator';
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

// Errands and events live in memory until the Postgres repo lands.
const money = new ErrandMoney({ payments: paypalPayments(paypal), repo: new MemoryErrandRepo() });

const app = buildServer({
  logger: true,
  verifyPayPal: (headers, rawBody) => verifyWebhookSignature(paypal, { headers, rawBody, webhookId }),
  events: new MemoryEventStore(),
  onPayPalEvent: async (event) => {
    const outcome = await money.handlePayPalEvent(event);
    app.log.info({ id: event.id, type: event.event_type, outcome }, 'PayPal event');
  },
});

const port = Number(process.env.PORT ?? 3001);
app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
