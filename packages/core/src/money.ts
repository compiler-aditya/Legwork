/**
 * Money is held as integer cents in one currency. PayPal's API uses decimal
 * strings, so every amount crosses the boundary through toPayPal/fromPayPal.
 */
export type Currency = 'USD';

export interface Money {
  readonly cents: number;
  readonly currency: Currency;
}

export class MoneyRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyRuleError';
  }
}

export function usd(cents: number): Money {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new MoneyRuleError(`Not a valid amount in cents: ${cents}`);
  }
  return { cents, currency: 'USD' };
}

const DECIMAL = /^(\d+)(?:\.(\d{1,2}))?$/;

/** Parses PayPal's "12.34" form exactly (no floating point). */
export function fromPayPal(value: string, currency: string): Money {
  if (currency !== 'USD') throw new MoneyRuleError(`Unsupported currency: ${currency}`);
  const m = DECIMAL.exec(value);
  if (!m) throw new MoneyRuleError(`Not a PayPal amount: ${value}`);
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? '').padEnd(2, '0'));
  return usd(whole * 100 + frac);
}

function decimal(m: Money): string {
  const whole = Math.floor(m.cents / 100);
  const frac = String(m.cents % 100).padStart(2, '0');
  return `${whole}.${frac}`;
}

/** Orders and Payments APIs: { currency_code, value }. */
export function toPayPal(m: Money): { currency_code: Currency; value: string } {
  return { currency_code: m.currency, value: decimal(m) };
}

/** Payouts API: { currency, value }. */
export function toPayoutAmount(m: Money): { currency: Currency; value: string } {
  return { currency: m.currency, value: decimal(m) };
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return usd(a.cents + b.cents);
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  if (b.cents > a.cents) throw new MoneyRuleError('Result would be negative');
  return usd(a.cents - b.cents);
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new MoneyRuleError('Currency mismatch');
}

export interface MoneyRules {
  /** Deposit as a percentage of the agreed total. */
  readonly depositPercent: number;
  /** Deposit never exceeds this, because it is paid out before pickup. */
  readonly depositCapCents: number;
}

export const DEFAULT_RULES: MoneyRules = { depositPercent: 30, depositCapCents: 2000 };

/**
 * Deposit = the lower of depositPercent of the total (rounded down to whole
 * dollars) and the cap. $34 -> $10; $100 -> $20.
 */
export function depositFor(total: Money, rules: MoneyRules = DEFAULT_RULES): Money {
  const percent = Math.floor((total.cents * rules.depositPercent) / 100 / 100) * 100;
  return usd(Math.min(percent, rules.depositCapCents, total.cents));
}

/**
 * The orchestrator calls this before every capture. A capture may never take
 * more than the approved contract total, however much the hold allows (PayPal
 * itself would allow up to 115% of an authorization).
 */
export function assertCaptureAllowed(args: {
  contractTotal: Money;
  hold: Money;
  capturedSoFar: Money;
  amount: Money;
}): void {
  const { contractTotal, hold, capturedSoFar, amount } = args;
  if (amount.cents <= 0) throw new MoneyRuleError('Capture amount must be positive');
  if (contractTotal.cents > hold.cents) {
    throw new MoneyRuleError('Contract total is above the held amount');
  }
  if (capturedSoFar.cents + amount.cents > contractTotal.cents) {
    throw new MoneyRuleError(
      `Capture of ${decimal(amount)} would exceed the contract total of ${decimal(contractTotal)} ` +
        `(already captured ${decimal(capturedSoFar)})`,
    );
  }
}

/** A deal can be confirmed on a call only if it fits inside the buyer's hold. */
export function fitsHold(price: Money, hold: Money): boolean {
  return price.currency === hold.currency && price.cents > 0 && price.cents <= hold.cents;
}
