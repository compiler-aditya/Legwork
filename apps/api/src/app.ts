import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { PgErrandRepo, PgEventStore, migrate, pgDatabase } from '@legwork/db';
import { ErrandMoney, MemoryErrandRepo, paypalPayments, type ErrandRepo } from '@legwork/orchestrator';
import { PayPalClient, verifyWebhookSignature, type PayPalEnv } from '@legwork/paypal';
import { MemoryEventStore, type EventStore } from './events';
import { buildServer, type Background } from './server';
import type { VoiceDeps } from './voice';

export interface AppStatus {
  storage: 'postgres' | 'memory';
  migrationsApplied: string[];
  paypal: { client: boolean; webhook: boolean; env: PayPalEnv };
  voice: boolean;
}

export interface AppOptions {
  env: NodeJS.ProcessEnv;
  /** How work after a reply is kept alive: setImmediate on a server, waitUntil on Vercel. */
  background?: Background;
  /** Where migrations/*.sql are when the code is bundled (the Vercel function). */
  migrationsDir?: string;
  /** Called with each new Postgres pool, e.g. Vercel's attachDatabasePool. */
  onPool?: (pool: pg.Pool) => void;
  logger?: boolean;
}

/**
 * Builds the API from environment variables. Only what is configured is
 * switched on, so the API starts (and /health answers) before PayPal or
 * ElevenLabs keys exist, which is when their webhooks are registered against it.
 */
export async function createApp(opts: AppOptions): Promise<{ app: FastifyInstance; status: AppStatus }> {
  const env = opts.env;
  const paypalEnv = (env.PAYPAL_ENV as PayPalEnv | undefined) ?? 'sandbox';

  // Storage. Advisory locks need a real session, which a transaction pooler
  // (Neon's pooled URL) does not keep, so the direct URL wins when both exist.
  let repo: ErrandRepo;
  let events: EventStore;
  let migrationsApplied: string[] = [];
  const dbUrl = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
  if (dbUrl) {
    const pool = new pg.Pool({ connectionString: dbUrl, max: Number(env.DATABASE_POOL_MAX ?? 10), idleTimeoutMillis: 10_000 });
    // An idle connection the server closed must not crash the process.
    pool.on('error', (err) => console.warn('postgres idle client error:', err.message));
    opts.onPool?.(pool);
    const db = pgDatabase(pool);
    migrationsApplied = await migrate(db, opts.migrationsDir);
    repo = new PgErrandRepo(db);
    events = new PgEventStore(db);
  } else {
    repo = new MemoryErrandRepo();
    events = new MemoryEventStore();
  }

  // PayPal. The client works without a webhook id; webhooks need one.
  let money: ErrandMoney | undefined;
  let paypal: PayPalClient | undefined;
  if (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) {
    paypal = new PayPalClient({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, env: paypalEnv });
    money = new ErrandMoney({ payments: paypalPayments(paypal), repo });
  }
  const webhookId = env.PAYPAL_WEBHOOK_ID;

  // Voice: needs the post-call secret and the call token secret.
  let voice: VoiceDeps | undefined;
  if (env.ELEVENLABS_WEBHOOK_SECRET && env.CALL_TOKEN_SECRET) {
    voice = {
      callTokenSecret: env.CALL_TOKEN_SECRET,
      webhookSecret: env.ELEVENLABS_WEBHOOK_SECRET,
      // Logged until the outreach workflow stores them.
      recordQuote: async (claims, quote) => {
        app.log.info({ errandId: claims.errandId, outreachId: claims.outreachId, quote }, 'quote recorded');
      },
      confirmOrder: async (claims, deal) =>
        money ? money.confirmDeal(claims.errandId, deal) : { ok: false, reason: 'payments are not set up yet' },
      afterConfirm: async (claims) => {
        await money?.payDeposit(claims.errandId);
      },
      onCallReport: async (report) => {
        app.log.info({ report: { ...report, lines: 'lines' in report ? report.lines.length : undefined } }, 'call report');
      },
    };
  }

  const status: AppStatus = {
    storage: dbUrl ? 'postgres' : 'memory',
    migrationsApplied,
    paypal: { client: !!paypal, webhook: !!(paypal && webhookId), env: paypalEnv },
    voice: !!voice,
  };

  const app = buildServer({
    logger: opts.logger ?? true,
    ...(opts.background ? { background: opts.background } : {}),
    health: {
      storage: status.storage,
      paypal: status.paypal,
      voice: status.voice,
      ...(env.VERCEL_GIT_COMMIT_SHA ? { commit: env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) } : {}),
    },
    verifyPayPal: async (headers, rawBody) => {
      // Throwing answers 503, so PayPal keeps retrying until the keys are in place.
      if (!paypal || !webhookId) throw new Error('PayPal is not configured: set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_WEBHOOK_ID');
      return verifyWebhookSignature(paypal, { headers, rawBody, webhookId });
    },
    events,
    onPayPalEvent: async (event) => {
      if (!money) throw new Error('PayPal is not configured');
      const outcome = await money.handlePayPalEvent(event);
      app.log.info({ id: event.id, type: event.event_type, outcome }, 'PayPal event');
    },
    ...(voice ? { voice } : {}),
  });
  return { app, status };
}
