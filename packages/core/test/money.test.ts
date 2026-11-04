import { describe, expect, it } from 'vitest';
import {
  MoneyRuleError,
  assertCaptureAllowed,
  depositFor,
  fitsHold,
  fromPayPal,
  subtract,
  toPayPal,
  toPayoutAmount,
  usd,
} from '../src/money';

describe('PayPal amounts', () => {
  it('round-trips decimal strings without floating point', () => {
    expect(fromPayPal('34.00', 'USD')).toEqual(usd(3400));
    expect(fromPayPal('0.1', 'USD')).toEqual(usd(10));
    expect(fromPayPal('19.99', 'USD')).toEqual(usd(1999));
    expect(toPayPal(usd(1999))).toEqual({ currency_code: 'USD', value: '19.99' });
    expect(toPayPal(usd(5))).toEqual({ currency_code: 'USD', value: '0.05' });
    expect(toPayoutAmount(usd(1000))).toEqual({ currency: 'USD', value: '10.00' });
  });

  it('refuses malformed amounts and other currencies', () => {
    expect(() => fromPayPal('12.345', 'USD')).toThrow(MoneyRuleError);
    expect(() => fromPayPal('-1.00', 'USD')).toThrow(MoneyRuleError);
    expect(() => fromPayPal('1.00', 'EUR')).toThrow(MoneyRuleError);
    expect(() => usd(1.5)).toThrow(MoneyRuleError);
  });

  it('never goes negative', () => {
    expect(() => subtract(usd(100), usd(200))).toThrow(MoneyRuleError);
    expect(subtract(usd(4000), usd(3400))).toEqual(usd(600));
  });
});

describe('deposit rule', () => {
  it('is 30% rounded down to whole dollars, capped at $20', () => {
    expect(depositFor(usd(3400))).toEqual(usd(1000)); // the demo: $34 -> $10
    expect(depositFor(usd(10000))).toEqual(usd(2000)); // cap
    expect(depositFor(usd(299))).toEqual(usd(0)); // under $3.34 there is no deposit
  });
});

describe('capture guard', () => {
  const hold = usd(4000);
  const contractTotal = usd(3400);

  it('allows a deposit then the balance, up to the contract total', () => {
    expect(() =>
      assertCaptureAllowed({ contractTotal, hold, capturedSoFar: usd(0), amount: usd(1000) }),
    ).not.toThrow();
    expect(() =>
      assertCaptureAllowed({ contractTotal, hold, capturedSoFar: usd(1000), amount: usd(2400) }),
    ).not.toThrow();
  });

  it('refuses anything past the contract total, even inside the hold', () => {
    expect(() =>
      assertCaptureAllowed({ contractTotal, hold, capturedSoFar: usd(1000), amount: usd(2401) }),
    ).toThrow(/exceed the contract total/);
  });

  it('refuses a contract above the hold, and zero captures', () => {
    expect(() =>
      assertCaptureAllowed({ contractTotal: usd(4100), hold, capturedSoFar: usd(0), amount: usd(100) }),
    ).toThrow(/above the held amount/);
    expect(() =>
      assertCaptureAllowed({ contractTotal, hold, capturedSoFar: usd(0), amount: usd(0) }),
    ).toThrow(/positive/);
  });

  it('only confirms deals that fit the hold', () => {
    expect(fitsHold(usd(3400), hold)).toBe(true);
    expect(fitsHold(usd(4000), hold)).toBe(true);
    expect(fitsHold(usd(4001), hold)).toBe(false);
    expect(fitsHold(usd(0), hold)).toBe(false);
  });
});
