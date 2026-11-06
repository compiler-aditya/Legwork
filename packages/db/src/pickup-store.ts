import type { Pickup, PickupStore } from '@legwork/messaging';
import type { Database } from './database';

interface Row {
  contract_id: string;
  errand_id: string;
  shop_phone: string;
  buyer_phone: string | null;
  status: Pickup['status'];
  wrong_attempts: number;
}

const COLUMNS = 'contract_id, errand_id, shop_phone, buyer_phone, status, wrong_attempts';

export class PgPickupStore implements PickupStore {
  constructor(private readonly db: Database) {}

  async create(p: Pickup): Promise<boolean> {
    const { rows } = await this.db.query(
      `INSERT INTO pickups (contract_id, errand_id, shop_phone, buyer_phone, status, wrong_attempts)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (contract_id) DO NOTHING RETURNING contract_id`,
      [p.contractId, p.errandId, p.shopPhone, p.buyerPhone ?? null, p.status, p.wrongAttempts],
    );
    return rows.length > 0;
  }

  async save(p: Pickup): Promise<void> {
    await this.db.query(`UPDATE pickups SET status = $2, wrong_attempts = $3, updated_at = now() WHERE contract_id = $1`, [p.contractId, p.status, p.wrongAttempts]);
  }

  async get(contractId: string): Promise<Pickup | undefined> {
    return (await this.many(`SELECT ${COLUMNS} FROM pickups WHERE contract_id = $1`, [contractId]))[0];
  }

  forErrand(errandId: string): Promise<Pickup[]> {
    return this.many(`SELECT ${COLUMNS} FROM pickups WHERE errand_id = $1 ORDER BY created_at`, [errandId]);
  }

  openForShop(shopPhone: string): Promise<Pickup[]> {
    return this.many(`SELECT ${COLUMNS} FROM pickups WHERE shop_phone = $1 AND status = 'open' ORDER BY created_at`, [shopPhone]);
  }

  private async many(sql: string, params: unknown[]): Promise<Pickup[]> {
    const { rows } = await this.db.query<Row>(sql, params);
    return rows.map((r) => ({
      contractId: r.contract_id,
      errandId: r.errand_id,
      shopPhone: r.shop_phone,
      status: r.status,
      wrongAttempts: r.wrong_attempts,
      ...(r.buyer_phone !== null ? { buyerPhone: r.buyer_phone } : {}),
    }));
  }
}
