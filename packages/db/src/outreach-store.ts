import type { OutreachPlan, OutreachRow, OutreachStore } from '@legwork/outreach';
import type { Database } from './database';

interface Row {
  id: string;
  errand_id: string;
  business_id: string;
  round: number;
  provider_ref: string | null;
  status: OutreachRow['status'];
  quote: OutreachRow['quote'] | null;
  offer: OutreachRow['offer'] | null;
  attempt: number;
  result: OutreachRow['result'] | null;
  retry_at: Date | null;
  started_at: Date | null;
  ended_at: Date | null;
  transcript: OutreachRow['transcript'] | null;
  error: string | null;
}

const COLUMNS = 'id, errand_id, business_id, round, provider_ref, status, quote, offer, attempt, result, retry_at, started_at, ended_at, transcript, error';

/** Plans in errand_plans, one row per call in outreach; shops are kept in businesses. */
export class PgOutreachStore implements OutreachStore {
  constructor(private readonly db: Database) {}

  async savePlan(plan: OutreachPlan): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const shop of plan.shops) {
        await tx.query(
          `INSERT INTO businesses (id, name, phone) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, updated_at = now()`,
          [shop.businessId, shop.name, shop.phone],
        );
      }
      await tx.query(
        `INSERT INTO errand_plans (errand_id, plan) VALUES ($1, $2::jsonb)
         ON CONFLICT (errand_id) DO UPDATE SET plan = EXCLUDED.plan, updated_at = now()`,
        [plan.errandId, JSON.stringify(plan)],
      );
    });
  }

  async getPlan(errandId: string): Promise<OutreachPlan | undefined> {
    const { rows } = await this.db.query<{ plan: OutreachPlan }>(`SELECT plan FROM errand_plans WHERE errand_id = $1`, [errandId]);
    return rows[0]?.plan;
  }

  async save(row: OutreachRow): Promise<void> {
    await this.db.query(
      `INSERT INTO outreach (id, errand_id, business_id, round, channel, provider_ref, status, quote, offer, attempt, result, retry_at, started_at, ended_at, transcript, error)
       VALUES ($1, $2, $3, $4, 'voice', $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14::jsonb, $15)
       ON CONFLICT (id) DO UPDATE SET
         provider_ref = EXCLUDED.provider_ref, status = EXCLUDED.status, quote = EXCLUDED.quote, offer = EXCLUDED.offer,
         attempt = EXCLUDED.attempt, result = EXCLUDED.result, retry_at = EXCLUDED.retry_at, started_at = EXCLUDED.started_at,
         ended_at = EXCLUDED.ended_at, transcript = EXCLUDED.transcript, error = EXCLUDED.error, updated_at = now()`,
      [
        row.id,
        row.errandId,
        row.businessId,
        row.round,
        row.conversationId ?? null,
        row.status,
        json(row.quote),
        json(row.offer),
        row.attempt,
        row.result ?? null,
        row.retryAt ?? null,
        row.startedAt ?? null,
        row.endedAt ?? null,
        json(row.transcript),
        row.error ?? null,
      ],
    );
  }

  async get(id: string): Promise<OutreachRow | undefined> {
    return this.one(`SELECT ${COLUMNS} FROM outreach WHERE id = $1`, [id]);
  }

  async listByErrand(errandId: string): Promise<OutreachRow[]> {
    return this.many(`SELECT ${COLUMNS} FROM outreach WHERE errand_id = $1 ORDER BY round, started_at NULLS LAST, id`, [errandId]);
  }

  async findByConversation(conversationId: string): Promise<OutreachRow | undefined> {
    return this.one(`SELECT ${COLUMNS} FROM outreach WHERE provider_ref = $1`, [conversationId]);
  }

  async dueRetries(now: Date): Promise<OutreachRow[]> {
    return this.many(`SELECT ${COLUMNS} FROM outreach WHERE status = 'retry' AND retry_at <= $1 ORDER BY retry_at`, [now.toISOString()]);
  }

  async staleCalls(startedBefore: Date): Promise<OutreachRow[]> {
    return this.many(`SELECT ${COLUMNS} FROM outreach WHERE status = 'calling' AND started_at < $1 ORDER BY started_at`, [startedBefore.toISOString()]);
  }

  private async one(sql: string, params: unknown[]): Promise<OutreachRow | undefined> {
    return (await this.many(sql, params))[0];
  }

  private async many(sql: string, params: unknown[]): Promise<OutreachRow[]> {
    const { rows } = await this.db.query<Row>(sql, params);
    return rows.map(fromRow);
  }
}

function fromRow(r: Row): OutreachRow {
  const row: OutreachRow = { id: r.id, errandId: r.errand_id, businessId: r.business_id, round: r.round === 2 ? 2 : 1, status: r.status, attempt: r.attempt };
  if (r.provider_ref !== null) row.conversationId = r.provider_ref;
  if (r.quote !== null) row.quote = r.quote;
  if (r.offer !== null) row.offer = r.offer;
  if (r.result !== null) row.result = r.result;
  if (r.retry_at !== null) row.retryAt = iso(r.retry_at);
  if (r.started_at !== null) row.startedAt = iso(r.started_at);
  if (r.ended_at !== null) row.endedAt = iso(r.ended_at);
  if (r.transcript !== null) row.transcript = r.transcript;
  if (r.error !== null) row.error = r.error;
  return row;
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
