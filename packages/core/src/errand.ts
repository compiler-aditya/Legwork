/**
 * The errand lifecycle as a table of allowed transitions. The orchestrator
 * is the only caller; anything not in the table is refused, so a late or
 * duplicate event can never move an errand backwards or skip a money step.
 *
 * Events whose names end in _CONFIRMED or _CAPTURED / _RELEASED come only
 * from verified PayPal webhooks.
 */
export const ERRAND_STATES = [
  'requested',
  'planned',
  'hold_pending', // waiting for the buyer to approve the budget hold in PayPal
  'held', // PayPal confirmed the authorization
  'quoting', // round 1: quote calls in parallel
  'comparing',
  'confirming', // round 2: one call back to the best shop
  'contracted',
  'deposit_pending',
  'deposit_paid',
  'awaiting_pickup',
  'settling',
  'releasing', // no deal: the hold is being voided
  'settled',
  'released',
  'failed',
] as const;

export type ErrandState = (typeof ERRAND_STATES)[number];

export const ERRAND_EVENTS = [
  'PLAN_READY',
  'HOLD_REQUESTED',
  'HOLD_CONFIRMED',
  'QUOTES_STARTED',
  'QUOTES_DONE',
  'BEST_CHOSEN',
  'NO_GOOD_QUOTE',
  'CONTRACT_CONFIRMED',
  'SHOP_DECLINED',
  'DEPOSIT_REQUESTED',
  'DEPOSIT_CAPTURED',
  'PICKUP_SCHEDULED',
  'CODE_CONFIRMED',
  'BALANCE_CAPTURED',
  'HOLD_RELEASED',
  'SHOP_CANCELLED',
  'FAIL',
] as const;

export type ErrandEvent = (typeof ERRAND_EVENTS)[number];

export const TERMINAL_STATES: ReadonlySet<ErrandState> = new Set(['settled', 'released', 'failed']);

/** States after a contract exists, where a shop cancellation sends the errand back to compare. */
const REBOOKABLE: readonly ErrandState[] = ['contracted', 'deposit_pending', 'deposit_paid', 'awaiting_pickup'];

const TABLE: Readonly<Partial<Record<ErrandState, Partial<Record<ErrandEvent, ErrandState>>>>> = {
  requested: { PLAN_READY: 'planned' },
  planned: { HOLD_REQUESTED: 'hold_pending' },
  hold_pending: { HOLD_CONFIRMED: 'held' },
  held: { QUOTES_STARTED: 'quoting' },
  quoting: { QUOTES_DONE: 'comparing' },
  comparing: { BEST_CHOSEN: 'confirming', NO_GOOD_QUOTE: 'releasing' },
  confirming: { CONTRACT_CONFIRMED: 'contracted', SHOP_DECLINED: 'comparing' },
  contracted: { DEPOSIT_REQUESTED: 'deposit_pending' },
  deposit_pending: { DEPOSIT_CAPTURED: 'deposit_paid' },
  deposit_paid: { PICKUP_SCHEDULED: 'awaiting_pickup' },
  awaiting_pickup: { CODE_CONFIRMED: 'settling' },
  settling: { BALANCE_CAPTURED: 'settled' },
  releasing: { HOLD_RELEASED: 'released' },
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: ErrandState,
    readonly event: ErrandEvent,
  ) {
    super(`Errand in state "${from}" cannot take event "${event}"`);
    this.name = 'InvalidTransitionError';
  }
}

export function nextState(from: ErrandState, event: ErrandEvent): ErrandState {
  if (TERMINAL_STATES.has(from)) throw new InvalidTransitionError(from, event);
  if (event === 'FAIL') return 'failed';
  if (event === 'SHOP_CANCELLED') {
    if (REBOOKABLE.includes(from)) return 'comparing';
    throw new InvalidTransitionError(from, event);
  }
  const to = TABLE[from]?.[event];
  if (!to) throw new InvalidTransitionError(from, event);
  return to;
}

export function canTake(from: ErrandState, event: ErrandEvent): boolean {
  try {
    nextState(from, event);
    return true;
  } catch {
    return false;
  }
}

/** Replays a list of events from the start; used by tests and by audits of the ledger. */
export function replay(events: readonly ErrandEvent[], from: ErrandState = 'requested'): ErrandState {
  return events.reduce<ErrandState>((state, event) => nextState(state, event), from);
}
