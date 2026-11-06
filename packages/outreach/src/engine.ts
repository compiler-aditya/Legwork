import type { ContractReview, Money } from '@legwork/core';
import type { Errand, ErrandMoney } from '@legwork/orchestrator';
import { mintCallToken, type CallClaims, type CallReport, type CallVariables, type Quote } from '@legwork/voice';
import { chooseBest, dollars } from './choose';
import { isFinal, type OutreachPlan, type OutreachResult, type OutreachRow, type Shop } from './model';
import type { OutreachStore } from './store';

/** Places one call. Production binds it to ElevenLabs behind the consent allowlist. */
export interface Caller {
  place(input: { to: string; variables: CallVariables }): Promise<{ conversationId: string }>;
}

/** The money steps the rounds take; the money service does the rest. */
export type MoneyActions = Pick<ErrandMoney, 'advance' | 'noDeal'>;

export interface OutreachOptions {
  store: OutreachStore;
  errands: { get(errandId: string): Promise<Errand | undefined> };
  money: MoneyActions;
  caller: Caller;
  callTokenSecret: string;
  /** A lock other processes respect (Postgres advisory lock); calls for one errand run one at a time. */
  lock?: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  now?: () => Date;
  /** Round 1 calls at most this many shops at once (the design's limit is 3). */
  maxParallel?: number;
  /** Calls per shop when it does not answer or is busy. */
  maxAttempts?: number;
  retryDelayMs?: number;
  /** A live call with no report after this long is treated as ended. */
  callTimeoutMs?: number;
}

export class OutreachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutreachError';
  }
}

const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * The outreach rounds for an errand, driven by events:
 *
 *   start (hold confirmed) -> round 1: quote calls to up to 3 shops at once
 *   record_quote tool      -> the quote lands on the shop's row
 *   post-call webhook      -> the row ends; when every round-1 row has ended,
 *                             pick the best quote and call that shop back (round 2)
 *   round 2 ends           -> confirmed: the money service has the contract;
 *                             otherwise try the next best quote, or release the hold
 *   tick (a timer)         -> retries for no-answer and busy, and calls that never reported
 *
 * Money moves only through the money service: this engine advances the
 * errand and asks for the hold to be released when nobody can do it.
 */
export class OutreachEngine {
  private readonly o: Required<Omit<OutreachOptions, 'lock'>> & Pick<OutreachOptions, 'lock'>;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(opts: OutreachOptions) {
    this.o = { maxParallel: 3, maxAttempts: 2, retryDelayMs: 2 * 60_000, callTimeoutMs: 20 * 60_000, now: () => new Date(), ...opts };
  }

  /** Saves the planner's choice of shops for an errand that exists and has not started its calls. */
  async plan(plan: OutreachPlan): Promise<void> {
    if (!plan.shops.length) throw new OutreachError('A plan needs at least one shop');
    const ids = new Set<string>();
    for (const s of plan.shops) {
      if (!E164.test(s.phone)) throw new OutreachError(`${s.name}: phone ${s.phone} is not E.164`);
      if (ids.has(s.businessId)) throw new OutreachError(`${s.businessId} is listed twice`);
      ids.add(s.businessId);
    }
    if (!Number.isInteger(plan.quantity) || plan.quantity < 1) throw new OutreachError('Quantity must be a whole number above zero');
    await this.locked(plan.errandId, async () => {
      const errand = await this.errand(plan.errandId);
      if ((await this.o.store.listByErrand(plan.errandId)).length) throw new OutreachError(`Errand ${plan.errandId} has already started its calls`);
      if (!['requested', 'planned', 'hold_pending', 'held'].includes(errand.state)) throw new OutreachError(`Errand ${plan.errandId} is ${errand.state}`);
      await this.o.store.savePlan(plan);
    });
  }

  /** Round 1. Call when PayPal confirms the hold (the errand is "held"). */
  start(errandId: string): Promise<OutreachRow[]> {
    return this.locked(errandId, async () => {
      const errand = await this.errand(errandId);
      if (errand.state !== 'held') return [];
      const plan = await this.planOf(errandId);
      await this.o.money.advance(errandId, 'QUOTES_STARTED', `calling ${Math.min(plan.shops.length, this.o.maxParallel)} shops`);
      const rows = await Promise.all(
        plan.shops.slice(0, this.o.maxParallel).map((shop) => this.dial(plan, shop, { id: rowId(errandId, 1, shop.businessId), round: 1, attempt: 1 })),
      );
      await this.advanceRounds(errandId);
      return rows;
    });
  }

  /** The record_quote tool, mid-call. */
  recordQuote(claims: CallClaims, quote: Quote): Promise<string> {
    return this.locked(claims.errandId, async () => {
      const row = await this.o.store.get(claims.outreachId);
      if (!row || row.errandId !== claims.errandId) return 'ignored: unknown outreach';
      row.quote = quote;
      await this.o.store.save(row);
      return 'quote recorded';
    });
  }

  /** The post-call webhook: a call connected and ended, or never connected. */
  async callEnded(report: CallReport): Promise<string> {
    if (report.kind === 'ignored') return 'ignored';
    const found = report.outreachId ? await this.o.store.get(report.outreachId) : await this.o.store.findByConversation(report.conversationId);
    if (!found) return 'ignored: unknown outreach';
    return this.locked(found.errandId, async () => {
      const row = (await this.o.store.get(found.id))!;
      if (row.status !== 'calling' || row.conversationId !== report.conversationId) return 'ignored: not the live call';
      if (report.kind === 'not_connected') {
        const result: OutreachResult = report.reason === 'busy' ? 'busy' : 'no_answer';
        if (row.attempt < this.o.maxAttempts) {
          row.status = 'retry';
          row.result = result;
          row.retryAt = new Date(this.o.now().getTime() + this.o.retryDelayMs).toISOString();
          await this.o.store.save(row);
          return `${result}; calling again at ${row.retryAt}`;
        }
        await this.end(row, result);
      } else {
        row.transcript = report.lines;
        await this.end(row, await this.resultOf(row));
      }
      await this.advanceRounds(row.errandId);
      return `${row.businessId}: ${row.result}`;
    });
  }

  /** After the money service handled a shop cancelling: try the next best quote. */
  afterShopCancelled(errandId: string): Promise<void> {
    return this.locked(errandId, () => this.advanceRounds(errandId));
  }

  /** Timers: due retries and calls that never reported. Safe to run often, from anywhere. */
  async tick(): Promise<string[]> {
    const done: string[] = [];
    const now = this.o.now();
    for (const due of await this.o.store.dueRetries(now)) {
      done.push(
        await this.locked(due.errandId, async () => {
          const row = (await this.o.store.get(due.id))!;
          if (row.status !== 'retry') return `${row.id}: already handled`;
          const plan = await this.planOf(row.errandId);
          const shop = plan.shops.find((s) => s.businessId === row.businessId)!;
          const again = await this.dial(plan, shop, { ...row, attempt: row.attempt + 1 });
          await this.advanceRounds(row.errandId);
          return `${row.id}: call ${again.attempt} ${again.status === 'calling' ? 'placed' : again.result}`;
        }),
      );
    }
    for (const stale of await this.o.store.staleCalls(new Date(now.getTime() - this.o.callTimeoutMs))) {
      done.push(
        await this.locked(stale.errandId, async () => {
          const row = (await this.o.store.get(stale.id))!;
          if (row.status !== 'calling') return `${row.id}: already handled`;
          const result = await this.resultOf(row);
          await this.end(row, result === 'no_quote' || result === 'not_confirmed' ? (row.round === 2 ? 'not_confirmed' : 'timed_out') : result);
          await this.advanceRounds(row.errandId);
          return `${row.id}: no report, ended as ${row.result}`;
        }),
      );
    }
    return done;
  }

  row(id: string): Promise<OutreachRow | undefined> {
    return this.o.store.get(id);
  }

  /** Keeps the contract extractor's reading with the confirmation call. */
  attachReview(rowId: string, review: ContractReview): Promise<void> {
    return this.o.store.get(rowId).then((found) => {
      if (!found) throw new OutreachError(`No outreach ${rowId}`);
      return this.locked(found.errandId, async () => {
        const row = (await this.o.store.get(rowId))!;
        row.review = review;
        await this.o.store.save(row);
      });
    });
  }

  async view(errandId: string): Promise<{ plan?: OutreachPlan; rows: OutreachRow[] }> {
    const plan = await this.o.store.getPlan(errandId);
    const rows = (await this.o.store.listByErrand(errandId)).sort((a, b) => a.round - b.round || (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
    return plan ? { plan, rows } : { rows };
  }

  // ---- the rounds -------------------------------------------------------------

  /** Moves the errand as far as the finished calls allow. */
  private async advanceRounds(errandId: string): Promise<void> {
    let errand = await this.errand(errandId);
    const rows = await this.o.store.listByErrand(errandId);

    if (errand.state === 'quoting') {
      const round1 = rows.filter((r) => r.round === 1);
      if (round1.some((r) => !isFinal(r))) return;
      const quoted = round1.filter((r) => r.result === 'quoted').length;
      await this.o.money.advance(errandId, 'QUOTES_DONE', `${quoted} of ${round1.length} shops quoted`);
      errand = await this.errand(errandId);
    }

    if (errand.state === 'confirming') {
      const live = rows.filter((r) => r.round === 2).sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0];
      if (!live || !isFinal(live) || live.result === 'confirmed') return;
      await this.o.money.advance(errandId, 'SHOP_DECLINED', `${live.businessId}: ${live.result}`);
      errand = await this.errand(errandId);
    }

    if (errand.state === 'comparing') await this.confirmBest(errand, rows);
  }

  /** Round 2: call back the best shop not yet tried, or release the hold. */
  private async confirmBest(errand: Errand, rows: OutreachRow[]): Promise<void> {
    const plan = await this.planOf(errand.id);
    const tried = new Set([...rows.filter((r) => r.round === 2).map((r) => r.businessId), ...errand.cancelledContracts.map((c) => c.businessId)]);
    const held = errand.hold?.remaining;
    if (!held) throw new OutreachError(`Errand ${errand.id} has no hold`);
    const { pick } = chooseBest({ rows, plan, held, exclude: tried });
    if (!pick) {
      await this.o.money.noDeal(errand.id, tried.size ? 'no other shop could do it' : 'no shop quoted within the hold');
      return;
    }
    await this.o.money.advance(errand.id, 'BEST_CHOSEN', `${pick.row.businessId} at ${dollars(pick.quoted)}, asking ${dollars(pick.ask)}`);
    const shop = plan.shops.find((s) => s.businessId === pick.row.businessId)!;
    await this.dial(plan, shop, { id: rowId(errand.id, 2, shop.businessId), round: 2, attempt: 1, offer: { ask: pick.ask, quoted: pick.quoted } });
  }

  /** Places a call for a row and saves it: live, or ended if the call could not be placed. */
  private async dial(plan: OutreachPlan, shop: Shop, base: Pick<OutreachRow, 'id' | 'round' | 'attempt'> & Partial<OutreachRow>): Promise<OutreachRow> {
    const row: OutreachRow = { ...base, errandId: plan.errandId, businessId: shop.businessId, status: 'calling', startedAt: this.o.now().toISOString() };
    delete row.retryAt;
    delete row.result;
    const variables: CallVariables = {
      errand_id: plan.errandId,
      outreach_id: row.id,
      round: row.round === 2 ? '2' : '1',
      business_name: shop.name,
      buyer_first_name: plan.buyerFirstName,
      item_description: plan.item,
      quantity: String(plan.quantity),
      quoted_price: row.offer ? amount(row.offer.quoted) : '',
      offer_price: row.offer ? amount(row.offer.ask) : '',
      pickup_window: plan.pickupWindow,
      call_token: mintCallToken(
        this.o.callTokenSecret,
        { errandId: plan.errandId, outreachId: row.id, businessId: shop.businessId, round: row.round, dialled: shop.phone },
        undefined,
        this.o.now().getTime(),
      ),
    };
    try {
      const { conversationId } = await this.o.caller.place({ to: shop.phone, variables });
      row.conversationId = conversationId;
    } catch (err) {
      row.status = 'ended';
      row.result = 'call_failed';
      row.error = err instanceof Error ? err.message : String(err);
      row.endedAt = this.o.now().toISOString();
    }
    await this.o.store.save(row);
    return row;
  }

  private async end(row: OutreachRow, result: OutreachResult): Promise<void> {
    row.status = 'ended';
    row.result = result;
    row.endedAt = this.o.now().toISOString();
    delete row.retryAt;
    await this.o.store.save(row);
  }

  /** What a call that connected came to. */
  private async resultOf(row: OutreachRow): Promise<OutreachResult> {
    if (row.round === 2) {
      const errand = await this.errand(row.errandId);
      return errand.contract?.outreachId === row.id ? 'confirmed' : 'not_confirmed';
    }
    const q = row.quote;
    if (!q) return 'no_quote';
    if (q.declinedAiCalls) return 'opted_out';
    return q.inStock && q.price ? 'quoted' : 'unavailable';
  }

  private async errand(errandId: string): Promise<Errand> {
    const errand = await this.o.errands.get(errandId);
    if (!errand) throw new OutreachError(`No errand ${errandId}`);
    return errand;
  }

  private async planOf(errandId: string): Promise<OutreachPlan> {
    const plan = await this.o.store.getPlan(errandId);
    if (!plan) throw new OutreachError(`Errand ${errandId} has no outreach plan`);
    return plan;
  }

  /** One errand at a time: an in-process queue, plus the cross-process lock when there is one. */
  private locked<T>(errandId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(errandId) ?? Promise.resolve();
    const body = () => (this.o.lock ? this.o.lock(`outreach:${errandId}`, fn) : fn());
    const run = previous.catch(() => undefined).then(body);
    this.queues.set(errandId, run);
    return run.finally(() => {
      if (this.queues.get(errandId) === run) this.queues.delete(errandId);
    });
  }
}

export function rowId(errandId: string, round: 1 | 2, businessId: string): string {
  return `${errandId}.r${round}.${businessId}`;
}

function amount(m: Money): string {
  return (m.cents / 100).toFixed(2);
}

/** Refuses to dial any number whose owner has not agreed to a call from an AI. */
export function consentingOnly(caller: Caller, allowed: Iterable<string>): Caller {
  const set = new Set(allowed);
  return {
    place: async (input) => {
      if (!set.has(input.to)) throw new OutreachError(`${input.to} has not agreed to AI calls (add it to CALL_ALLOWLIST)`);
      return caller.place(input);
    },
  };
}
