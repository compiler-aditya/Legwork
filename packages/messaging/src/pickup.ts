import { subtract, type Money } from '@legwork/core';
import type { Errand, ErrandMoney } from '@legwork/orchestrator';
import type { OutreachPlan } from '@legwork/outreach';
import type { Pickup, PickupStore } from './store';

/** Sends one text. Production binds it to Twilio behind the consent allowlist. */
export interface Sms {
  send(to: string, body: string): Promise<unknown>;
}

export interface PickupDeskOptions {
  money: Pick<ErrandMoney, 'advance' | 'confirmPickupCode'>;
  errands: { get(errandId: string): Promise<Errand | undefined> };
  plans: { getPlan(errandId: string): Promise<OutreachPlan | undefined> };
  store: PickupStore;
  sms: Sms;
  /** Whether a number may be texted; shops need consent, the buyer gave their number for this. Default: anyone. */
  canText?: (to: string, who: 'shop' | 'buyer') => boolean;
  /** Wrong codes allowed per pickup before it locks for a person to look at. */
  maxWrongAttempts?: number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * The pickup handover by text.
 *
 * Once the deposit is paid, the shop gets the order summary and the buyer
 * gets the pickup code. At the counter the buyer gives the shop the code and
 * the shop texts it back; a match captures the balance. The shop never learns
 * the code any other way, so it cannot claim the balance unless the buyer
 * was there. Wrong codes are limited, so four digits cannot be guessed.
 */
export class PickupDesk {
  private readonly maxWrong: number;

  constructor(private readonly o: PickupDeskOptions) {
    this.maxWrong = o.maxWrongAttempts ?? 5;
  }

  /** After PayPal confirmed the deposit capture and the shop was paid. Safe to call twice. */
  async depositPaid(errandId: string): Promise<string> {
    const errand = await this.o.errands.get(errandId);
    const contract = errand?.contract;
    if (!errand || !contract) return 'ignored: no contract';
    if (errand.state !== 'deposit_paid') return `ignored: errand is ${errand.state}`;
    const plan = await this.o.plans.getPlan(errandId);
    const shop = plan?.shops.find((s) => s.businessId === contract.businessId);
    if (!plan || !shop) return 'ignored: no plan for the shop';

    const pickup: Pickup = { contractId: contract.id, errandId, shopPhone: shop.phone, status: 'open', wrongAttempts: 0, ...(plan.buyerPhone ? { buyerPhone: plan.buyerPhone } : {}) };
    if (!(await this.o.store.create(pickup))) return 'ignored: pickup already scheduled';
    await this.o.money.advance(errandId, 'PICKUP_SCHEDULED', `pickup ${contract.pickupAt ?? 'as agreed'}`);

    const balance = subtract(contract.total, contract.deposit);
    const when = contract.pickupAt ? `, ready ${contract.pickupAt}` : '';
    await this.text(shop.phone, 'shop', `Legwork: order confirmed. ${contract.quantity} x ${contract.item}, ${usd(contract.total)}${when}, for ${plan.buyerFirstName}. ` +
      `${contract.deposit.cents > 0 ? `${usd(contract.deposit)} deposit sent by PayPal. ` : ''}` +
      `At pickup ${plan.buyerFirstName} gives you a 4-digit code: reply to this text with it and the remaining ${usd(balance)} is sent at once.`);
    if (plan.buyerPhone) {
      await this.text(plan.buyerPhone, 'buyer', `Legwork: ${shop.name} has your ${contract.item}${when}. Your pickup code is ${contract.pickupCode}. Give it to them at the counter; PayPal pays the rest (${usd(balance)}) when they text it back.`);
    }
    return 'pickup scheduled';
  }

  /**
   * A text from a shop. Returns the reply to send back (TwiML), never the code.
   */
  async inbound(from: string, body: string): Promise<string> {
    const open = await this.o.store.openForShop(from);
    if (!open.length) return 'Legwork: there is no pickup waiting for this number.';
    const code = /\b(\d{4})\b/.exec(body)?.[1];
    if (!code) return 'Legwork: reply with the 4-digit code the customer gives you at pickup.';

    for (const pickup of open) {
      const result = await this.o.money.confirmPickupCode(pickup.errandId, code);
      if (result.ok) {
        pickup.status = 'confirmed';
        await this.o.store.save(pickup);
        const errand = await this.o.errands.get(pickup.errandId);
        const balance = errand?.contract ? usd(subtract(errand.contract.total, errand.contract.deposit)) : 'the balance';
        return `Legwork: code confirmed, thank you. ${balance} is on its way to you through PayPal.`;
      }
    }

    // No match: count it against every open pickup for this shop.
    let locked = 0;
    let left = this.maxWrong;
    for (const pickup of open) {
      pickup.wrongAttempts += 1;
      if (pickup.wrongAttempts >= this.maxWrong) {
        pickup.status = 'locked';
        locked += 1;
        this.o.log?.('pickup locked after wrong codes', { errandId: pickup.errandId, contractId: pickup.contractId });
      }
      left = Math.min(left, this.maxWrong - pickup.wrongAttempts);
      await this.o.store.save(pickup);
    }
    if (locked) return 'Legwork: too many codes that do not match. A person from Legwork will contact you to finish this order.';
    return `Legwork: that code does not match. ${left} ${left === 1 ? 'try' : 'tries'} left.`;
  }

  /** After PayPal confirmed the balance capture: the buyer's receipt. */
  async balancePaid(errandId: string): Promise<string> {
    const errand = await this.o.errands.get(errandId);
    const contract = errand?.contract;
    const plan = await this.o.plans.getPlan(errandId);
    if (!errand || !contract || !plan?.buyerPhone) return 'ignored: no receipt to send';
    const shop = plan.shops.find((s) => s.businessId === contract.businessId);
    const released = subtract(errand.budgetMax, contract.total);
    await this.text(plan.buyerPhone, 'buyer', `Legwork: done. You paid ${usd(contract.total)} to ${shop?.name ?? 'the shop'} through PayPal${released.cents > 0 ? `; the other ${usd(released)} of your hold is released` : ''}.`);
    return 'receipt sent';
  }

  private async text(to: string, who: 'shop' | 'buyer', body: string): Promise<void> {
    if (this.o.canText && !this.o.canText(to, who)) {
      this.o.log?.('not texted: no consent for this number', { to, who });
      return;
    }
    try {
      await this.o.sms.send(to, body);
    } catch (err) {
      // A text that fails must not undo the money step it reports on.
      this.o.log?.('text not sent', { to, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

function usd(m: Money): string {
  return `$${(m.cents / 100).toFixed(2)}`;
}
