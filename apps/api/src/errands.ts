import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { usd } from '@legwork/core';
import type { ErrandMoney, ErrandRepo } from '@legwork/orchestrator';
import type { OutreachEngine } from '@legwork/outreach';

export interface ErrandDeps {
  /** Bearer token for creating and reading errands (LEGWORK_ADMIN_TOKEN), until buyer sign-in exists. */
  adminToken: string;
  /** Also accepted on /internal/tick: Vercel Cron sends CRON_SECRET as a bearer token. */
  cronSecret?: string;
  /** Where PayPal sends the buyer back after approving the hold. */
  publicUrl: string;
  money: ErrandMoney;
  repo: Pick<ErrandRepo, 'get'>;
  outreach: OutreachEngine;
  ensureUser(id: string, name: string): Promise<void>;
}

const cents = z.number().int().positive().max(1_000_000);
const CreateErrand = z.object({
  userId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  userName: z.string().trim().min(1).max(100),
  request: z.object({ kind: z.enum(['item', 'custom_order']), text: z.string().trim().min(1).max(2000) }),
  budgetMaxCents: cents,
  plan: z.object({
    item: z.string().trim().min(1).max(300),
    quantity: z.number().int().min(1).max(10_000),
    pickupWindow: z.string().trim().min(1).max(200),
    buyerFirstName: z.string().trim().min(1).max(50),
    benchmark: z.object({ priceCents: cents, source: z.string().trim().min(1).max(200), url: z.url().optional() }).optional(),
    shops: z
      .array(z.object({ businessId: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/), name: z.string().trim().min(1).max(200), phone: z.string().regex(/^\+[1-9]\d{6,14}$/) }))
      .min(1)
      .max(10),
  }),
});

/**
 * Errands over HTTP, for the web app and for testing the rounds by hand:
 *
 *   POST /errands          plan and budget in; the PayPal approve link out
 *   GET  /paypal/return    PayPal sends the buyer back; the hold is authorized
 *                          and round 1 starts when PayPal's webhook confirms it
 *   GET  /errands/:id      the errand, its money state and every call
 *   POST /internal/tick    retries and lost calls (also run on every webhook)
 */
export function registerErrandRoutes(app: FastifyInstance, deps: ErrandDeps): void {
  const allowed = (req: FastifyRequest, ...tokens: Array<string | undefined>) => {
    const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    return tokens.some((t) => t && given.length === Buffer.byteLength(t) && timingSafeEqual(given, Buffer.from(t)));
  };

  app.post('/errands', async (req, reply) => {
    if (!allowed(req, deps.adminToken)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const parsed = CreateErrand.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: z.prettifyError(parsed.error) });
    const input = parsed.data;
    const errandId = `err_${randomBytes(6).toString('hex')}`;
    await deps.ensureUser(input.userId, input.userName);
    await deps.money.createErrand({ id: errandId, userId: input.userId, request: input.request, budgetMax: usd(input.budgetMaxCents) });
    const { benchmark, ...plan } = input.plan;
    await deps.outreach.plan({
      errandId,
      ...plan,
      ...(benchmark ? { benchmark: { price: usd(benchmark.priceCents), source: benchmark.source, ...(benchmark.url ? { url: benchmark.url } : {}) } } : {}),
    });
    await deps.money.advance(errandId, 'PLAN_READY', 'created over the API');
    const { approveUrl } = await deps.money.requestHold(errandId, {
      returnUrl: `${deps.publicUrl}/paypal/return?errand=${errandId}`,
      cancelUrl: `${deps.publicUrl}/paypal/cancel?errand=${errandId}`,
      savePayPal: true,
      description: `Legwork: ${plan.item}, up to $${(input.budgetMaxCents / 100).toFixed(2)}`.slice(0, 127),
    });
    return reply.code(201).send({ ok: true, errandId, approveUrl });
  });

  app.get<{ Params: { id: string } }>('/errands/:id', async (req, reply) => {
    if (!allowed(req, deps.adminToken)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    // Reading an errand also runs the timers, so a page polling it keeps retries moving.
    await deps.outreach.tick();
    const errand = await deps.repo.get(req.params.id);
    if (!errand) return reply.code(404).send({ ok: false, error: 'not found' });
    return { ok: true, errand, outreach: await deps.outreach.view(errand.id) };
  });

  app.post('/internal/tick', async (req, reply) => {
    if (!allowed(req, deps.adminToken, deps.cronSecret)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    return { ok: true, done: await deps.outreach.tick() };
  });

  app.get<{ Querystring: { errand?: string; token?: string } }>('/paypal/return', async (req, reply) => {
    const errand = req.query.errand ? await deps.repo.get(req.query.errand) : undefined;
    // PayPal appends the order id as token; it must be this errand's hold.
    if (!errand || !errand.hold || errand.hold.orderId !== req.query.token) return page(reply.code(404), 'This approval link is not for a Legwork errand.');
    if (errand.state === 'hold_pending' && !errand.hold.authorizationId) await deps.money.buyerApproved(errand.id);
    return page(reply, 'Thanks. PayPal is holding your budget, and Legwork is calling the shops now. Nothing is charged until a shop agrees.');
  });

  app.get('/paypal/cancel', async (_req, reply) => page(reply, 'No problem: nothing was held and no shop will be called.'));
}

function page(reply: { type(t: string): { send(body: string): unknown } }, text: string) {
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Legwork</title><body style="font:17px/1.5 system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem"><h1 style="font-size:1.4rem">Legwork</h1><p>${text}</p></body>`;
  return reply.type('text/html; charset=utf-8').send(body);
}
