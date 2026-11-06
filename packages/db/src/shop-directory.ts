import { distanceKm, rankShops, type BusinessInput, type ShopDirectory, type ShopListing, type ShopQuery } from '@legwork/agents';
import type { Database } from './database';

export type { BusinessInput };

interface Row {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  lat: number;
  lon: number;
  categories: string[];
  description: string | null;
  accepts_ai_calls: boolean;
  reliability: number;
}

/** The businesses table as the planner's shop directory: a box around the buyer, then distance and match. */
export class PgShopDirectory implements ShopDirectory {
  constructor(private readonly db: Database) {}

  async near(q: ShopQuery): Promise<ShopListing[]> {
    const dLat = q.radiusKm / 111;
    const dLon = q.radiusKm / (111 * Math.max(0.1, Math.cos((q.lat * Math.PI) / 180)));
    const { rows } = await this.db.query<Row>(
      `SELECT id, name, phone, address, lat, lon, categories, description, accepts_ai_calls, reliability
       FROM businesses WHERE lat BETWEEN $1 AND $2 AND lon BETWEEN $3 AND $4`,
      [q.lat - dLat, q.lat + dLat, q.lon - dLon, q.lon + dLon],
    );
    const within = rows
      .map((r): ShopListing => ({
        businessId: r.id,
        name: r.name,
        categories: r.categories,
        distanceKm: Math.round(distanceKm(q, { lat: r.lat, lon: r.lon }) * 10) / 10,
        acceptsAiCalls: r.accepts_ai_calls,
        reliability: r.reliability,
        ...(r.phone ? { phone: r.phone } : {}),
        ...(r.address ? { address: r.address } : {}),
        ...(r.description ? { description: r.description } : {}),
      }))
      .filter((s) => s.distanceKm <= q.radiusKm);
    return rankShops(within, q.what, q.limit);
  }

  async upsert(b: BusinessInput): Promise<void> {
    await this.db.query(
      `INSERT INTO businesses (id, name, phone, address, lat, lon, categories, description, accepts_ai_calls)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, address = EXCLUDED.address,
         lat = EXCLUDED.lat, lon = EXCLUDED.lon, categories = EXCLUDED.categories, description = EXCLUDED.description,
         accepts_ai_calls = EXCLUDED.accepts_ai_calls, updated_at = now()`,
      [b.businessId, b.name, b.phone ?? null, b.address ?? null, b.lat, b.lon, b.categories, b.description ?? null, b.acceptsAiCalls ?? true],
    );
  }
}
