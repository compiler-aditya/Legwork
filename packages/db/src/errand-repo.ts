import { usd } from '@legwork/core';
import type { Errand, ErrandRepo, MoneyKind, MoneyStep, Transition } from '@legwork/orchestrator';
import type { ErrandEvent, ErrandState } from '@legwork/core';
import type { Database } from './database';

interface ErrandRow {
  id: string;
  user_id: string;
  kind: 'item' | 'custom_order';
  request_text: string;
  budget_max_cents: number;
  state: ErrandState;
  money: Pick<Errand, 'hold' | 'contract' | 'captures' | 'payouts' | 'cancelledContracts'>;
  attention: string | null;
}

interface MoneyStepRow {
  request_id: string;
  errand_id: string;
  kind: MoneyKind;
  amount_cents: number;
  status: 'requested' | 'sent' | 'confirmed' | 'failed';
  paypal_id: string | null;
}

/** Which money_steps column holds the PayPal id a step was sent with. */
const SENT_ID_COLUMN: Record<MoneyKind, string> = {
  authorize: 'paypal_authorization_id',
  void: 'paypal_authorization_id',
  reauthorize: 'paypal_authorization_id',
  capture_deposit: 'paypal_capture_id',
  capture_balance: 'paypal_capture_id',
  payout_deposit: 'paypal_payout_batch_id',
  payout_balance: 'paypal_payout_batch_id',
  refund: 'paypal_refund_id',
};

/**
 * Errands in Postgres. The errands row holds the orchestrator's money state as
 * JSON; transitions and money steps are append-only rows, so the history of
 * every dollar can be read back without trusting the JSON.
 */
export class PgErrandRepo implements ErrandRepo {
  constructor(private readonly db: Database) {}

  async get(errandId: string): Promise<Errand | undefined> {
    const { rows } = await this.db.query<ErrandRow>(
      `SELECT id, user_id, kind, request_text, budget_max_cents, state, money, attention FROM errands WHERE id = $1`,
      [errandId],
    );
    const row = rows[0];
    if (!row) return undefined;
    const money = row.money;
    const errand: Errand = {
      id: row.id,
      userId: row.user_id,
      request: { kind: row.kind, text: row.request_text },
      state: row.state,
      budgetMax: usd(row.budget_max_cents),
      captures: money.captures ?? {},
      payouts: money.payouts ?? {},
      cancelledContracts: money.cancelledContracts ?? [],
    };
    if (money.hold) errand.hold = money.hold;
    if (money.contract) errand.contract = money.contract;
    if (row.attention !== null) errand.attention = row.attention;
    return errand;
  }

  async save(errand: Errand): Promise<void> {
    const { hold, contract, captures, payouts, cancelledContracts } = errand;
    await this.db.query(
      `INSERT INTO errands (id, user_id, kind, request_text, budget_max_cents, state, money, attention)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       ON CONFLICT (id) DO UPDATE SET
         state = EXCLUDED.state, money = EXCLUDED.money, attention = EXCLUDED.attention, updated_at = now()`,
      [
        errand.id,
        errand.userId,
        errand.request.kind,
        errand.request.text,
        errand.budgetMax.cents,
        errand.state,
        JSON.stringify({ hold, contract, captures, payouts, cancelledContracts }),
        errand.attention ?? null,
      ],
    );
  }

  async appendTransition(t: Transition): Promise<void> {
    await this.db.query(
      `INSERT INTO errand_transitions (errand_id, from_state, event, to_state, cause) VALUES ($1, $2, $3, $4, $5)`,
      [t.errandId, t.from, t.event, t.to, t.cause],
    );
  }

  async appendMoneyStep(step: MoneyStep): Promise<void> {
    const idColumn = SENT_ID_COLUMN[step.kind];
    await this.db.query(
      `INSERT INTO money_steps (errand_id, kind, amount_cents, currency, request_id, status, ${idColumn})
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [step.errandId, step.kind, step.amount.cents, step.amount.currency, step.requestId, step.status, step.paypalId ?? null],
    );
  }

  /**
   * Moves a step to confirmed or failed. A step that already reached either
   * stays as it is (late or repeated webhooks); the table's trigger refuses
   * any other route.
   */
  async markMoneyStep(requestId: string, patch: Pick<MoneyStep, 'status'> & { paypalId?: string }): Promise<void> {
    await this.db.query(
      `UPDATE money_steps SET
         status = $2::text,
         confirmed_at = CASE WHEN $2::text = 'confirmed' THEN now() ELSE confirmed_at END,
         paypal_authorization_id = CASE WHEN kind IN ('authorize', 'void', 'reauthorize') THEN COALESCE($3::text, paypal_authorization_id) ELSE paypal_authorization_id END,
         paypal_capture_id = CASE WHEN kind IN ('capture_deposit', 'capture_balance') THEN COALESCE($3::text, paypal_capture_id) ELSE paypal_capture_id END,
         paypal_payout_item_id = CASE WHEN kind IN ('payout_deposit', 'payout_balance') THEN COALESCE($3::text, paypal_payout_item_id) ELSE paypal_payout_item_id END,
         paypal_refund_id = CASE WHEN kind = 'refund' THEN COALESCE($3::text, paypal_refund_id) ELSE paypal_refund_id END
       WHERE request_id = $1 AND status NOT IN ('confirmed', 'failed')`,
      [requestId, patch.status, patch.paypalId ?? null],
    );
  }

  withLock<T>(errandId: string, fn: () => Promise<T>): Promise<T> {
    return this.db.withLock(`errand:${errandId}`, fn);
  }

  // ---- reads for receipts, the timeline and tests ---------------------------

  async moneySteps(errandId: string): Promise<MoneyStep[]> {
    const { rows } = await this.db.query<MoneyStepRow>(
      `SELECT request_id, errand_id, kind, amount_cents, status,
              COALESCE(paypal_payout_item_id, paypal_payout_batch_id, paypal_capture_id, paypal_refund_id, paypal_authorization_id) AS paypal_id
       FROM money_steps WHERE errand_id = $1 ORDER BY id`,
      [errandId],
    );
    return rows.map((r) => {
      const step: MoneyStep = {
        requestId: r.request_id,
        errandId: r.errand_id,
        kind: r.kind,
        amount: usd(r.amount_cents),
        status: r.status === 'requested' ? 'sent' : r.status,
      };
      if (r.paypal_id !== null) step.paypalId = r.paypal_id;
      return step;
    });
  }

  async transitions(errandId: string): Promise<Transition[]> {
    const { rows } = await this.db.query<{ errand_id: string; from_state: ErrandState; event: ErrandEvent; to_state: ErrandState; cause: string | null }>(
      `SELECT errand_id, from_state, event, to_state, cause FROM errand_transitions WHERE errand_id = $1 ORDER BY id`,
      [errandId],
    );
    return rows.map((r) => ({ errandId: r.errand_id, from: r.from_state, event: r.event, to: r.to_state, cause: r.cause ?? '' }));
  }

  /** Errands waiting on a person, newest first. */
  async needingAttention(limit = 50): Promise<Array<{ id: string; attention: string }>> {
    const { rows } = await this.db.query<{ id: string; attention: string }>(
      `SELECT id, attention FROM errands WHERE attention IS NOT NULL ORDER BY updated_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  }
}
