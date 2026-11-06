import { Channel3 } from '@channel3/sdk';
import { usd, type Money } from '@legwork/core';

/** One product the online catalogue matched, with its cheapest US-dollar offer. */
export interface ProductMatch {
  id: string;
  title: string;
  brand?: string;
  /** The cheapest in-stock offer in USD, if any. */
  price?: Money;
  merchant?: string;
  url?: string;
}

/** Identifies a product from words or a photo and prices it online. */
export interface ProductFinder {
  search(query: string): Promise<ProductMatch[]>;
  searchByImage(imageUrl: string): Promise<ProductMatch[]>;
}

/** Channel3's product search, reduced to what the planner needs. */
export class Channel3Products implements ProductFinder {
  private readonly client: Channel3;

  constructor(apiKey: string, private readonly limit = 5) {
    this.client = new Channel3({ apiKey });
  }

  async search(query: string): Promise<ProductMatch[]> {
    const page = await this.client.products.search({ query });
    return page.data.slice(0, this.limit).map(toMatch);
  }

  async searchByImage(imageUrl: string): Promise<ProductMatch[]> {
    const page = await this.client.products.searchByImage({ image_url: imageUrl });
    return page.data.slice(0, this.limit).map(toMatch);
  }
}

interface Channel3Product {
  id: string;
  title: string;
  brands?: Array<{ name: string }>;
  offers?: Array<{ url: string; domain: string; price: { price: number; currency: string }; availability?: unknown }>;
}

function toMatch(p: Channel3Product): ProductMatch {
  const offers = (p.offers ?? []).filter((o) => o.price.currency === 'USD' && Number.isFinite(o.price.price) && o.price.price > 0 && String(o.availability ?? 'InStock') !== 'OutOfStock');
  const best = offers.sort((a, b) => a.price.price - b.price.price)[0];
  const match: ProductMatch = { id: p.id, title: p.title };
  if (p.brands?.[0]?.name) match.brand = p.brands[0].name;
  if (best) {
    match.price = usd(Math.round(best.price.price * 100));
    match.merchant = best.domain;
    match.url = best.url;
  }
  return match;
}
