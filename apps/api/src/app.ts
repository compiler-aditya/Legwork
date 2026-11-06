import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { PgErrandRepo, PgEventStore, PgOutreachStore, migrate, pgDatabase, type Database } from '@legwork/db';
import { ErrandMoney, MemoryErrandRepo, paypalPayments, type ErrandRepo, type PaymentsPort } from '@legwork/orchestrator';
import { MemoryOutreachStore, OutreachEngine, consentingOnly, type Caller, type OutreachStore } from '@legwork/outreach';
import { PayPalClient, verifyWebhookSignature, type HeaderBag, type PayPalEnv } from '@legwork/paypal';
import { ElevenLabsClient } from '@legwork/voice';
import { registerErrandRoutes } from './errands';
import { MemoryEventStore, type EventStore } from './events';
import { buildServer, type Background } from './server';
import type { VoiceDeps } from './voice';

export interface AppStatus {
  storage: 'postgres' | 'memory';
  migrationsApplied: string[];
  paypal: { client: boolean; webhook: boolean; env: PayPalEnv };
  /** The agent's tools and the post-call webhook. */
  voice: boolean;
  /** Outbound calls through ElevenLabs, and how many consenting numbers may be dialled. */
  calls: { enabled: boolean; allowlisted: number };
  /** POST /errands and friends (needs LEGWORK_ADMIN_TOKEN). */
  errands: boolean;
}

export interface AppOptions {
  env: NodeJS.ProcessEnv;
  /** How work after a reply is kept alive: setImmediate on a server, waitUntil on Vercel. */
  background?: Background;
  /** Where migrations/*.sql are when the code is bundled (the Vercel function). */
  migrationsDir?: string;
  /** Called with each new Postgres pool, e.g. Vercel's attachDatabasePool. */
  onPool?: (pool: pg.Pool) => void;
  /** Replaces ElevenLabs as the way calls are placed (tests). */
  caller?: Caller;
  /** Replaces PayPal (tests): the calls, and the webhook signature check. */
  paypal?: { payments: PaymentsPort; verify: (headers: HeaderBag, rawBody: string) => Promise<boolean> };
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
  let db: Database | undefined;
  let repo: ErrandRepo;
  let events: EventStore;
  let outreachStore: OutreachStore;
  let migrationsApplied: string[] = [];
  const dbUrl = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
  if (dbUrl) {
    const pool = new pg.Pool({ connectionString: dbUrl, max: Number(env.DATABASE_POOL_MAX ?? 10), idleTimeoutMillis: 10_000 });
    // An idle connection the server closed must not crash the process.
    pool.on('error', (err) => console.warn('postgres idle client error:', err.message));
    opts.onPool?.(pool);
    db = pgDatabase(pool);
    migrationsApplied = await migrate(db, opts.migrationsDir);
    repo = new PgErrandRepo(db);
    events = new PgEventStore(db);
    outreachStore = new PgOutreachStore(db);
  } else {
    repo = new MemoryErrandRepo();
    events = new MemoryEventStore();
    outreachStore = new MemoryOutreachStore();
  }

  // PayPal. The client works without a webhook id; webhooks need one.
  let money: ErrandMoney | undefined;
  let verify: ((headers: HeaderBag, rawBody: string) => Promise<boolean>) | undefined;
  if (opts.paypal) {
    money = new ErrandMoney({ payments: opts.paypal.payments, repo });
    verify = opts.paypal.verify;
  } else if (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) {
    const paypal = new PayPalClient({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, env: paypalEnv });
    money = new ErrandMoney({ payments: paypalPayments(paypal), repo });
    const webhookId = env.PAYPAL_WEBHOOK_ID;
    if (webhookId) verify = (headers, rawBody) => verifyWebhookSignature(paypal, { headers, rawBody, webhookId });
  }

  // Calls: only to numbers whose owners agreed to a call from an AI.
  const allowlist = (env.CALL_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  let caller: Caller;
  let callsEnabled = false;
  if (opts.caller) {
    caller = consentingOnly(opts.caller, allowlist);
    callsEnabled = true;
  } else if (env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID && env.ELEVENLABS_PHONE_NUMBER_ID) {
    const eleven = new ElevenLabsClient({ apiKey: env.ELEVENLABS_API_KEY });
    const agentId = env.ELEVENLABS_AGENT_ID;
    const agentPhoneNumberId = env.ELEVENLABS_PHONE_NUMBER_ID;
    caller = consentingOnly(
      { place: ({ to, variables }) => eleven.outboundCall({ agentId, agentPhoneNumberId, toNumber: to, dynamicVariables: { ...variables } }) },
      allowlist,
    );
    callsEnabled = true;
  } else {
    caller = {
      place: async () => {
        throw new Error('Calls are not set up: set ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID and ELEVENLABS_PHONE_NUMBER_ID');
      },
    };
  }

  // The outreach rounds need the money service and a way to sign call tokens.
  const outreach =
    money && env.CALL_TOKEN_SECRET
      ? new OutreachEngine({
          store: outreachStore,
          errands: repo,
          money,
          caller,
          callTokenSecret: env.CALL_TOKEN_SECRET,
          ...(db ? { lock: db.withLock.bind(db) } : {}),
        })
      : undefined;
  const tick = async () => {
    const done = (await outreach?.tick()) ?? [];
    if (done.length) app.log.info({ done }, 'outreach timers');
  };

  // Voice: the agent's tools and the post-call webhook.
  let voice: VoiceDeps | undefined;
  if (env.ELEVENLABS_WEBHOOK_SECRET && env.CALL_TOKEN_SECRET) {
    voice = {
      callTokenSecret: env.CALL_TOKEN_SECRET,
      webhookSecret: env.ELEVENLABS_WEBHOOK_SECRET,
      recordQuote: async (claims, quote) => {
        const outcome = outreach ? await outreach.recordQuote(claims, quote) : 'no outreach engine';
        app.log.info({ errandId: claims.errandId, outreachId: claims.outreachId, quote, outcome }, 'quote');
      },
      confirmOrder: async (claims, deal) =>
        money ? money.confirmDeal(claims.errandId, deal) : { ok: false, reason: 'payments are not set up yet' },
      afterConfirm: async (claims) => {
        await money?.payDeposit(claims.errandId);
      },
      onCallReport: async (report) => {
        const outcome = outreach ? await outreach.callEnded(report) : 'no outreach engine';
        app.log.info({ kind: report.kind, conversationId: report.conversationId, outcome }, 'call report');
        await tick();
      },
    };
  }

  const publicUrl = (env.PUBLIC_API_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '')).replace(/\/$/, '');
  const errandRoutes = Boolean(env.LEGWORK_ADMIN_TOKEN && money && outreach && publicUrl);

  const status: AppStatus = {
    storage: dbUrl ? 'postgres' : 'memory',
    migrationsApplied,
    paypal: { client: !!money, webhook: !!verify, env: paypalEnv },
    voice: !!voice,
    calls: { enabled: callsEnabled, allowlisted: allowlist.length },
    errands: errandRoutes,
  };

  const app = buildServer({
    logger: opts.logger ?? true,
    ...(opts.background ? { background: opts.background } : {}),
    health: {
      storage: status.storage,
      paypal: status.paypal,
      voice: status.voice,
      calls: status.calls,
      errands: status.errands,
      ...(env.VERCEL_GIT_COMMIT_SHA ? { commit: env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) } : {}),
    },
    verifyPayPal: async (headers, rawBody) => {
      // Throwing answers 503, so PayPal keeps retrying until the keys are in place.
      if (!verify) throw new Error('PayPal is not configured: set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_WEBHOOK_ID');
      return verify(headers, rawBody);
    },
    events,
    onPayPalEvent: async (event) => {
      if (!money) throw new Error('PayPal is not configured');
      const outcome = await money.handlePayPalEvent(event);
      app.log.info({ id: event.id, type: event.event_type, outcome }, 'PayPal event');
      // The hold is in place: round 1 starts.
      const errandId = (event.resource as { custom_id?: unknown }).custom_id;
      if (outcome === 'hold confirmed' && outreach && typeof errandId === 'string') {
        const rows = await outreach.start(errandId);
        app.log.info({ errandId, calls: rows.map((r) => ({ shop: r.businessId, status: r.status, result: r.result, error: r.error })) }, 'round 1 started');
      }
      await tick();
    },
    ...(voice ? { voice } : {}),
  });

  if (errandRoutes) {
    registerErrandRoutes(app, {
      adminToken: env.LEGWORK_ADMIN_TOKEN!,
      ...(env.CRON_SECRET ? { cronSecret: env.CRON_SECRET } : {}),
      publicUrl,
      money: money!,
      repo,
      outreach: outreach!,
      ensureUser: async (id, name) => {
        await db?.query(`INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [id, name]);
      },
    });
  }
  return { app, status };
}
