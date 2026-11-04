import { describe, expect, it } from 'vitest';
import { InvalidTransitionError, canTake, nextState, replay } from '../src/errand';

describe('errand lifecycle', () => {
  it('runs the hero errand from request to settled', () => {
    expect(
      replay([
        'PLAN_READY',
        'HOLD_REQUESTED',
        'HOLD_CONFIRMED',
        'QUOTES_STARTED',
        'QUOTES_DONE',
        'BEST_CHOSEN',
        'CONTRACT_CONFIRMED',
        'DEPOSIT_REQUESTED',
        'DEPOSIT_CAPTURED',
        'PICKUP_SCHEDULED',
        'CODE_CONFIRMED',
        'BALANCE_CAPTURED',
      ]),
    ).toBe('settled');
  });

  it('releases the hold when no quote is good enough', () => {
    expect(
      replay(['PLAN_READY', 'HOLD_REQUESTED', 'HOLD_CONFIRMED', 'QUOTES_STARTED', 'QUOTES_DONE', 'NO_GOOD_QUOTE', 'HOLD_RELEASED']),
    ).toBe('released');
  });

  it('goes back to compare when the shop cancels after a contract, then can settle with another shop', () => {
    const afterDeposit = replay([
      'PLAN_READY',
      'HOLD_REQUESTED',
      'HOLD_CONFIRMED',
      'QUOTES_STARTED',
      'QUOTES_DONE',
      'BEST_CHOSEN',
      'CONTRACT_CONFIRMED',
      'DEPOSIT_REQUESTED',
      'DEPOSIT_CAPTURED',
    ]);
    expect(nextState(afterDeposit, 'SHOP_CANCELLED')).toBe('comparing');
    expect(
      replay(['BEST_CHOSEN', 'CONTRACT_CONFIRMED', 'DEPOSIT_REQUESTED', 'DEPOSIT_CAPTURED', 'PICKUP_SCHEDULED', 'CODE_CONFIRMED', 'BALANCE_CAPTURED'], 'comparing'),
    ).toBe('settled');
  });

  it('tries the next shop when the best one declines on the confirm call', () => {
    expect(nextState('confirming', 'SHOP_DECLINED')).toBe('comparing');
  });

  it('never lets money events arrive early or twice', () => {
    expect(() => nextState('planned', 'HOLD_CONFIRMED')).toThrow(InvalidTransitionError);
    expect(() => nextState('contracted', 'DEPOSIT_CAPTURED')).toThrow(InvalidTransitionError);
    expect(() => nextState('awaiting_pickup', 'BALANCE_CAPTURED')).toThrow(InvalidTransitionError);
    expect(canTake('deposit_paid', 'DEPOSIT_CAPTURED')).toBe(false);
  });

  it('only allows a shop cancellation once a contract exists', () => {
    expect(canTake('quoting', 'SHOP_CANCELLED')).toBe(false);
    expect(canTake('awaiting_pickup', 'SHOP_CANCELLED')).toBe(true);
  });

  it('keeps terminal states terminal', () => {
    expect(() => nextState('settled', 'FAIL')).toThrow(InvalidTransitionError);
    expect(() => nextState('released', 'PLAN_READY')).toThrow(InvalidTransitionError);
    expect(nextState('quoting', 'FAIL')).toBe('failed');
  });
});
