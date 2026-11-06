import type { OutreachPlan, OutreachRow } from './model';

/** Plans and outreach rows. Postgres in production (@legwork/db); memory in tests. */
export interface OutreachStore {
  savePlan(plan: OutreachPlan): Promise<void>;
  getPlan(errandId: string): Promise<OutreachPlan | undefined>;
  save(row: OutreachRow): Promise<void>;
  get(id: string): Promise<OutreachRow | undefined>;
  listByErrand(errandId: string): Promise<OutreachRow[]>;
  findByConversation(conversationId: string): Promise<OutreachRow | undefined>;
  /** Rows waiting to call again whose time has come. */
  dueRetries(now: Date): Promise<OutreachRow[]>;
  /** Live calls started before `startedBefore` that never reported back. */
  staleCalls(startedBefore: Date): Promise<OutreachRow[]>;
}

export class MemoryOutreachStore implements OutreachStore {
  readonly plans = new Map<string, OutreachPlan>();
  readonly rows = new Map<string, OutreachRow>();

  async savePlan(plan: OutreachPlan) {
    this.plans.set(plan.errandId, structuredClone(plan));
  }
  async getPlan(errandId: string) {
    const p = this.plans.get(errandId);
    return p ? structuredClone(p) : undefined;
  }
  async save(row: OutreachRow) {
    this.rows.set(row.id, structuredClone(row));
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : undefined;
  }
  async listByErrand(errandId: string) {
    return [...this.rows.values()].filter((r) => r.errandId === errandId).map((r) => structuredClone(r));
  }
  async findByConversation(conversationId: string) {
    const r = [...this.rows.values()].find((x) => x.conversationId === conversationId);
    return r ? structuredClone(r) : undefined;
  }
  async dueRetries(now: Date) {
    return [...this.rows.values()]
      .filter((r) => r.status === 'retry' && r.retryAt && Date.parse(r.retryAt) <= now.getTime())
      .map((r) => structuredClone(r));
  }
  async staleCalls(startedBefore: Date) {
    return [...this.rows.values()]
      .filter((r) => r.status === 'calling' && r.startedAt && Date.parse(r.startedAt) < startedBefore.getTime())
      .map((r) => structuredClone(r));
  }
}
