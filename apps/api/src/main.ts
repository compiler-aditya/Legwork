import pg from 'pg';
import { PgErrandRepo, PgEventStore, migrate, pgDatabase } from '@legwork/db';
import { ErrandMoney, MemoryErrandRepo, paypalPayments, type ErrandRepo } from '@legwork/orchestrator';
import { PayPalClient, verifyWebhookSignature, type PayPalEnv } from '@legwork/paypal';
import { MemoryEventStore, type EventStore } from './events';
import { buildServer } from './server';
import type { VoiceDeps } from './voice';

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

// Postgres when DATABASE_URL is set (Render sets it from legwork-db); memory otherwise.
let repo: ErrandRepo;
let events: EventStore;
let storage: string;
if (process.env.DATABASE_URL) {
  const db = pgDatabase(new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 }));
  const applied = await migrate(db);
  repo = new PgErrandRepo(db);
  events = new PgEventStore(db);
  storage = `postgres (migrations applied: ${applied.length ? applied.join(', ') : 'none'})`;
} else {
  repo = new MemoryErrandRepo();
  events = new MemoryEventStore();
  storage = 'memory: errands are lost on restart; set DATABASE_URL to keep them';
}

const money = new ErrandMoney({ payments: paypalPayments(paypal), repo });

// Voice: on when the ElevenLabs post-call secret and the call token secret are set.
// Quotes and call reports are logged until the outreach workflow stores them.
let voice: VoiceDeps | undefined;
if (process.env.ELEVENLABS_WEBHOOK_SECRET && process.env.CALL_TOKEN_SECRET) {
  voice = {
    callTokenSecret: process.env.CALL_TOKEN_SECRET,
    webhookSecret: process.env.ELEVENLABS_WEBHOOK_SECRET,
    recordQuote: async (claims, quote) => {
      app.log.info({ errandId: claims.errandId, outreachId: claims.outreachId, quote }, 'quote recorded');
    },
    confirmOrder: (claims, deal) => money.confirmDeal(claims.errandId, deal),
    afterConfirm: async (claims) => {
      await money.payDeposit(claims.errandId);
    },
    onCallReport: async (report) => {
      app.log.info({ report: { ...report, lines: 'lines' in report ? report.lines.length : undefined } }, 'call report');
    },
  };
}

const app = buildServer({
  logger: true,
  verifyPayPal: (headers, rawBody) => verifyWebhookSignature(paypal, { headers, rawBody, webhookId }),
  events,
  onPayPalEvent: async (event) => {
    const outcome = await money.handlePayPalEvent(event);
    app.log.info({ id: event.id, type: event.event_type, outcome }, 'PayPal event');
  },
  ...(voice ? { voice } : {}),
});
app.log.info(`storage: ${storage}`);
app.log.info(`voice: ${voice ? 'on' : 'off (set ELEVENLABS_WEBHOOK_SECRET and CALL_TOKEN_SECRET)'}`);

const port = Number(process.env.PORT ?? 3001);
app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
