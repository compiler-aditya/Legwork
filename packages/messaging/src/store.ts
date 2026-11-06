/** One pickup: a confirmed contract waiting for the shop to text back the buyer's code. */
export interface Pickup {
  contractId: string;
  errandId: string;
  /** The number Legwork called; only a text from it can confirm. */
  shopPhone: string;
  buyerPhone?: string;
  status: 'open' | 'confirmed' | 'locked';
  wrongAttempts: number;
}

export interface PickupStore {
  /** Saves it unless one exists for the contract; true when it was new. */
  create(pickup: Pickup): Promise<boolean>;
  save(pickup: Pickup): Promise<void>;
  get(contractId: string): Promise<Pickup | undefined>;
  forErrand(errandId: string): Promise<Pickup[]>;
  openForShop(shopPhone: string): Promise<Pickup[]>;
}

export class MemoryPickupStore implements PickupStore {
  readonly pickups = new Map<string, Pickup>();

  async create(p: Pickup) {
    if (this.pickups.has(p.contractId)) return false;
    this.pickups.set(p.contractId, { ...p });
    return true;
  }
  async save(p: Pickup) {
    this.pickups.set(p.contractId, { ...p });
  }
  async get(contractId: string) {
    const p = this.pickups.get(contractId);
    return p ? { ...p } : undefined;
  }
  async forErrand(errandId: string) {
    return [...this.pickups.values()].filter((p) => p.errandId === errandId).map((p) => ({ ...p }));
  }
  async openForShop(shopPhone: string) {
    return [...this.pickups.values()].filter((p) => p.shopPhone === shopPhone && p.status === 'open').map((p) => ({ ...p }));
  }
}
