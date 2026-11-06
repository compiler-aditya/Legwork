/** A local business the planner may call. */
export interface ShopListing {
  businessId: string;
  name: string;
  /** E.164; shops without one cannot be called. */
  phone?: string;
  address?: string;
  categories: string[];
  description?: string;
  distanceKm: number;
  /** False when the shop asked not to be called by an AI. */
  acceptsAiCalls: boolean;
  /** 0 to 1: how often the shop kept its word on past errands. */
  reliability: number;
}

export interface ShopQuery {
  lat: number;
  lon: number;
  radiusKm: number;
  /** What the shop should sell: "plumbing parts", "bakery", "phone repair". */
  what: string;
  limit: number;
}

/** Shops near a point, ranked by how well they match. Postgres today; the Elastic Offline Index next. */
export interface ShopDirectory {
  near(q: ShopQuery): Promise<ShopListing[]>;
}

/** A shop as it is added to the directory. */
export interface BusinessInput {
  businessId: string;
  name: string;
  phone?: string;
  address?: string;
  lat: number;
  lon: number;
  categories: string[];
  description?: string;
  acceptsAiCalls?: boolean;
}

/** Ranks shops by how many of the query's words their name, categories and description share, then distance. */
export function rankShops(shops: ShopListing[], what: string, limit: number): ShopListing[] {
  const words = tokens(what);
  return shops
    .map((s) => ({ s, score: overlap(words, tokens([s.name, ...s.categories, s.description ?? ''].join(' '))) }))
    .sort((a, b) => b.score - a.score || a.s.distanceKm - b.s.distanceKm)
    .slice(0, limit)
    .map(({ s }) => s);
}

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export class MemoryShopDirectory implements ShopDirectory {
  constructor(private readonly shops: Array<Omit<ShopListing, 'distanceKm'> & { lat: number; lon: number }> = []) {}

  async upsert(b: BusinessInput): Promise<void> {
    const { acceptsAiCalls, ...rest } = b;
    const shop = { ...rest, acceptsAiCalls: acceptsAiCalls ?? true, reliability: 0.5 };
    const i = this.shops.findIndex((s) => s.businessId === b.businessId);
    if (i >= 0) this.shops[i] = shop;
    else this.shops.push(shop);
  }

  async near(q: ShopQuery): Promise<ShopListing[]> {
    const within = this.shops
      .map(({ lat, lon, ...s }) => ({ ...s, distanceKm: round(distanceKm(q, { lat, lon })) }))
      .filter((s) => s.distanceKm <= q.radiusKm);
    return rankShops(within, q.what, q.limit);
  }
}

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'of', 'to', 'in', 'shop', 'store']);
function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/s$/, '')));
}
function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}
const round = (n: number) => Math.round(n * 10) / 10;
