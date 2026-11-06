import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { usd } from '@legwork/core';
import type { ErrandMoney, ErrandRepo } from '@legwork/orchestrator';
import type { PickupDesk, PickupStore } from '@legwork/messaging';
import type { OutreachEngine, OutreachPlan } from '@legwork/outreach';
import type { BusinessInput, Planner, PlannerResult } from '@legwork/agents';

export interface ErrandDeps {
  /** Bearer token for creating and reading errands (LEGWORK_ADMIN_TOKEN), until buyer sign-in exists. */
  adminToken: string;
  /** Also accepted on /internal/tick: Vercel Cron sends CRON_SECRET as a bearer token. */
  cronSecret?: string;
  /** Where PayPal sends the buyer back after approving the hold. */
  publicUrl: string;
  /** The web app; after approving, the buyer lands on the errand's page there. */
  webAppUrl?: string;
  money: ErrandMoney;
  repo: Pick<ErrandRepo, 'get'>;
  outreach: OutreachEngine;
  desk: PickupDesk;
  pickups: PickupStore;
  /** Claude plans the calls when a request comes without a plan (ANTHROPIC_API_KEY). */
  planner?: Planner;
  /** Where POST /businesses adds shops the planner can find. */
  directory: { upsert(b: BusinessInput): Promise<void> };
  ensureUser(id: string, name: string): Promise<void>;
}

const cents = z.number().int().positive().max(1_000_000);
const phone = z.string().regex(/^\+[1-9]\d{6,14}$/, 'an E.164 phone number like +14155550123');
const id = z.string().regex(/^[A-Za-z0-9_-]{1,60}$/);
const ExplicitPlan = z.object({
  item: z.string().trim().min(1).max(300),
  quantity: z.number().int().min(1).max(10_000),
  pickupWindow: z.string().trim().min(1).max(200),
  buyerFirstName: z.string().trim().min(1).max(50),
  buyerPhone: phone.optional(),
  benchmark: z.object({ priceCents: cents, source: z.string().trim().min(1).max(200), url: z.url().optional() }).optional(),
  shops: z.array(z.object({ businessId: id, name: z.string().trim().min(1).max(200), phone })).min(1).max(10),
});
/** What the planner needs when no plan is given. */
const PlannerInput = z.object({
  buyer: z.object({ firstName: z.string().trim().min(1).max(50), phone: phone.optional() }),
  location: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), label: z.string().trim().max(200).optional() }),
  photoUrl: z.url({ protocol: /^https$/ }).optional(),
  pickupWindow: z.string().trim().min(1).max(200).optional(),
});
const Base = z.object({
  request: z.object({ kind: z.enum(['item', 'custom_order']), text: z.string().trim().min(1).max(2000) }),
  budgetMaxCents: cents,
});
const CreateErrand = Base.extend({
  userId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  userName: z.string().trim().min(1).max(100),
  plan: ExplicitPlan.optional(),
}).extend(PlannerInput.partial().shape);
const PreviewPlan = Base.extend(PlannerInput.shape);
const Business = z.object({
  businessId: id,
  name: z.string().trim().min(1).max(200),
  phone: phone.optional(),
  address: z.string().trim().max(300).optional(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  categories: z.array(z.string().trim().min(1).max(60)).max(20),
  description: z.string().trim().max(1000).optional(),
  acceptsAiCalls: z.boolean().optional(),
});

/**
 * Errands over HTTP, for the web app and for testing the rounds by hand:
 *
 *   POST /errands          request and budget in (with a plan, or a location for
 *                          the planner); the PayPal approve link out
 *   POST /errands/plan     the planner's plan for a request, without starting anything
 *   POST /businesses       add a shop to the directory the planner searches
 *   GET  /paypal/return    PayPal sends the buyer back; the hold is authorized
 *                          and round 1 starts when PayPal's webhook confirms it
 *   GET  /errands/:id      the errand, its money state, every call and the pickup
 *   POST /errands/:id/pickup-code   the shop's code text, for demos without Twilio
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

    // The plan: as given, or from the planner.
    let plan: OutreachPlan;
    let planned: Extract<PlannerResult, { kind: 'plan' }> | undefined;
    if (input.plan) {
      const { benchmark, ...given } = input.plan;
      plan = { errandId, ...given, ...(benchmark ? { benchmark: { price: usd(benchmark.priceCents), source: benchmark.source, ...(benchmark.url ? { url: benchmark.url } : {}) } } : {}) };
    } else {
      const forPlanner = PlannerInput.safeParse(input);
      if (!forPlanner.success) return reply.code(400).send({ ok: false, error: 'Send a plan, or buyer and location for the planner' });
      if (!deps.planner) return reply.code(503).send({ ok: false, error: 'The planner is not set up (ANTHROPIC_API_KEY); send a plan instead' });
      const result = await runPlanner(deps.planner, { ...input, ...forPlanner.data });
      if (result.kind === 'question') return reply.send({ ok: false, question: result.question });
      planned = result;
      const b = forPlanner.data.buyer;
      plan = {
        errandId,
        item: result.item,
        quantity: result.quantity,
        pickupWindow: result.pickupWindow,
        buyerFirstName: b.firstName,
        ...(b.phone ? { buyerPhone: b.phone } : {}),
        shops: result.shops,
        ...(result.benchmark ? { benchmark: { price: result.benchmark.price, source: result.benchmark.source, ...(result.benchmark.url ? { url: result.benchmark.url } : {}) } } : {}),
      };
    }

    await deps.ensureUser(input.userId, input.userName);
    await deps.money.createErrand({ id: errandId, userId: input.userId, request: input.request, budgetMax: usd(input.budgetMaxCents) });
    await deps.outreach.plan(plan);
    await deps.money.advance(errandId, 'PLAN_READY', planned ? `planned by Claude: ${planned.reasoning}`.slice(0, 500) : 'plan given over the API');
    const { approveUrl } = await deps.money.requestHold(errandId, {
      returnUrl: `${deps.publicUrl}/paypal/return?errand=${errandId}`,
      cancelUrl: `${deps.publicUrl}/paypal/cancel?errand=${errandId}`,
      savePayPal: true,
      description: `Legwork: ${plan.item}, up to $${(input.budgetMaxCents / 100).toFixed(2)}`.slice(0, 127),
    });
    return reply.code(201).send({ ok: true, errandId, approveUrl, plan, ...(planned ? { reasoning: planned.reasoning } : {}) });
  });

  app.post('/errands/plan', async (req, reply) => {
    if (!allowed(req, deps.adminToken)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    if (!deps.planner) return reply.code(503).send({ ok: false, error: 'The planner is not set up (ANTHROPIC_API_KEY)' });
    const parsed = PreviewPlan.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: z.prettifyError(parsed.error) });
    return { ok: true, result: await runPlanner(deps.planner, parsed.data) };
  });

  app.post('/businesses', async (req, reply) => {
    if (!allowed(req, deps.adminToken)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const parsed = Business.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: z.prettifyError(parsed.error) });
    const { phone: p, address, description, acceptsAiCalls, ...rest } = parsed.data;
    await deps.directory.upsert({ ...rest, ...(p ? { phone: p } : {}), ...(address ? { address } : {}), ...(description ? { description } : {}), ...(acceptsAiCalls === undefined ? {} : { acceptsAiCalls }) });
    return reply.code(201).send({ ok: true, businessId: parsed.data.businessId });
  });

  app.get<{ Params: { id: string } }>('/errands/:id', async (req, reply) => {
    if (!allowed(req, deps.adminToken)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    // Reading an errand also runs the timers, so a page polling it keeps retries moving.
    await deps.outreach.tick();
    const errand = await deps.repo.get(req.params.id);
    if (!errand) return reply.code(404).send({ ok: false, error: 'not found' });
    return { ok: true, errand, outreach: await deps.outreach.view(errand.id), pickups: await deps.pickups.forErrand(errand.id) };
  });

  // For demos without Twilio: the shop's text with the code, as if it came from the shop's phone.
  app.post<{ Params: { id: string }; Body: { code?: unknown } }>('/errands/:id/pickup-code', async (req, reply) => {
    if (!allowed(req, deps.adminToken)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const open = (await deps.pickups.forErrand(req.params.id)).find((p) => p.status === 'open');
    if (!open) return reply.code(404).send({ ok: false, error: 'no open pickup' });
    const answer = await deps.desk.inbound(open.shopPhone, String(req.body?.code ?? ''));
    return { ok: true, reply: answer };
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
    if (deps.webAppUrl) return reply.redirect(`${deps.webAppUrl}/errands/${errand.id}`, 303);
    return page(reply, 'Thanks. PayPal is holding your budget, and Legwork is calling the shops now. Nothing is charged until a shop agrees.');
  });

  app.get('/paypal/cancel', async (_req, reply) => (deps.webAppUrl ? reply.redirect(`${deps.webAppUrl}/`, 303) : page(reply, 'No problem: nothing was held and no shop will be called.')));
}

function runPlanner(planner: Planner, input: z.infer<typeof PreviewPlan>): Promise<PlannerResult> {
  return planner.plan({
    text: input.request.text,
    budgetMax: usd(input.budgetMaxCents),
    location: { lat: input.location.lat, lon: input.location.lon, ...(input.location.label ? { label: input.location.label } : {}) },
    ...(input.photoUrl ? { photoUrl: input.photoUrl } : {}),
    ...(input.pickupWindow ? { pickupWindow: input.pickupWindow } : {}),
  });
}

function page(reply: { type(t: string): { send(body: string): unknown } }, text: string) {
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Legwork</title><body style="font:17px/1.5 system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem"><h1 style="font-size:1.4rem">Legwork</h1><p>${text}</p></body>`;
  return reply.type('text/html; charset=utf-8').send(body);
}
