/**
 * The errand as the API returns it (GET /errands/:id), and what the pages
 * show for it. Pure functions, so they can be tested without a browser.
 */

export interface Money {
  cents: number;
  currency: string;
}

export interface Contract {
  id: string;
  businessId: string;
  item: string;
  quantity: number;
  total: Money;
  deposit: Money;
  pickupCode: string;
  pickupAt?: string;
  payout: { type: string; receiver: string; wallet?: string };
}

export interface Errand {
  id: string;
  state: string;
  request: { kind: string; text: string };
  budgetMax: Money;
  hold?: { orderId: string; authorizationId?: string; remaining: Money };
  contract?: Contract;
  captures: { deposit?: string; balance?: string };
  payouts: { deposit?: { status: string }; balance?: { status: string } };
  cancelledContracts: Contract[];
  attention?: string;
}

export interface Term<V> {
  value: V;
  line: number;
  at: string;
  quote: string;
}

export interface Review {
  agreed: boolean;
  terms?: { item: Term<string>; quantity: Term<number>; totalCents: Term<number>; readyAt: Term<string> };
  mismatches: Array<{ field: string; fromTranscript: string | number; fromTools: string | number }>;
  unverified: string[];
  notes?: string;
}

export interface CallRow {
  id: string;
  businessId: string;
  round: 1 | 2;
  status: 'calling' | 'retry' | 'ended';
  attempt: number;
  quote?: { inStock: boolean; price?: Money; readyAt: string; itemOffered?: string; notes?: string };
  result?: string;
  offer?: { ask: Money; quoted: Money };
  startedAt?: string;
  endedAt?: string;
  retryAt?: string;
  transcript?: Array<{ line: number; at: string; speaker: 'agent' | 'shop'; text: string }>;
  review?: Review;
  error?: string;
}

export interface Plan {
  item: string;
  quantity: number;
  pickupWindow: string;
  buyerFirstName: string;
  benchmark?: { price: Money; source: string; url?: string };
  shops: Array<{ businessId: string; name: string; phone: string }>;
}

export interface ErrandView {
  errand: Errand;
  outreach: { plan?: Plan; rows: CallRow[] };
  pickups: Array<{ status: string; wrongAttempts: number }>;
}

export const usd = (m: Money | undefined) => (m ? `$${(m.cents / 100).toFixed(2)}` : '—');

/** The headline for each errand state, in the buyer's terms. */
export function headline(state: string): { title: string; tone: 'wait' | 'busy' | 'good' | 'done' | 'warn' } {
  const map: Record<string, { title: string; tone: 'wait' | 'busy' | 'good' | 'done' | 'warn' }> = {
    requested: { title: 'Planning your errand', tone: 'busy' },
    planned: { title: 'Planned', tone: 'wait' },
    hold_pending: { title: 'Approve your budget in PayPal to start the calls', tone: 'wait' },
    held: { title: 'PayPal is holding your budget', tone: 'busy' },
    quoting: { title: 'Calling shops for quotes', tone: 'busy' },
    comparing: { title: 'Comparing quotes', tone: 'busy' },
    confirming: { title: 'Confirming with the best shop', tone: 'busy' },
    contracted: { title: 'Order confirmed', tone: 'good' },
    deposit_pending: { title: 'Paying the shop a deposit', tone: 'busy' },
    deposit_paid: { title: 'Deposit paid to the shop', tone: 'good' },
    awaiting_pickup: { title: 'Ready for pickup', tone: 'good' },
    settling: { title: 'Paying the balance', tone: 'busy' },
    settled: { title: 'Done: collected and paid', tone: 'done' },
    releasing: { title: 'No shop could do it; releasing your hold', tone: 'warn' },
    released: { title: 'Nothing bought; your hold is released', tone: 'warn' },
    failed: { title: 'This errand needs a person', tone: 'warn' },
  };
  return map[state] ?? { title: state, tone: 'wait' };
}

export const STEPS = ['Plan', 'Hold', 'Quotes', 'Confirm', 'Deposit', 'Pickup', 'Done'] as const;

/** How far along the steps an errand is: the index of the current step. */
export function stepIndex(state: string): number {
  const at: Record<string, number> = {
    requested: 0, planned: 0, hold_pending: 1, held: 1, quoting: 2, comparing: 2, confirming: 3, contracted: 3,
    deposit_pending: 4, deposit_paid: 4, awaiting_pickup: 5, settling: 5, settled: 6, releasing: 6, released: 6, failed: 6,
  };
  return at[state] ?? 0;
}

export interface MoneyLine {
  label: string;
  amount: string;
  status: 'pending' | 'done' | 'skipped';
  detail: string;
}

/** The money, as PayPal holds and moves it, in order. */
export function moneyTrack(e: Errand): MoneyLine[] {
  const held = Boolean(e.hold?.authorizationId) && !['planned', 'hold_pending'].includes(e.state);
  const lines: MoneyLine[] = [
    { label: 'Budget held', amount: usd(e.budgetMax), status: held ? 'done' : 'pending', detail: held ? 'PayPal holds it; nothing is charged yet' : 'Waiting for your approval in PayPal' },
  ];
  if (e.state === 'releasing' || e.state === 'released') {
    lines.push({ label: 'Hold released', amount: usd(e.budgetMax), status: e.state === 'released' ? 'done' : 'pending', detail: 'Nothing was charged' });
    return lines;
  }
  const c = e.contract;
  if (!c) return lines;
  const balance = { cents: c.total.cents - c.deposit.cents, currency: c.total.currency };
  lines.push({
    label: 'Deposit to the shop',
    amount: usd(c.deposit),
    status: e.captures.deposit ? 'done' : 'pending',
    detail: e.captures.deposit ? `Captured; payout ${(e.payouts.deposit?.status ?? 'sent').toLowerCase()}` : 'Captured from the hold when the shop confirms',
  });
  lines.push({
    label: 'Balance at pickup',
    amount: usd(balance),
    status: e.captures.balance ? 'done' : 'pending',
    detail: e.captures.balance ? `Captured; payout ${(e.payouts.balance?.status ?? 'sent').toLowerCase()}` : 'When the shop texts back your pickup code',
  });
  const released = { cents: e.budgetMax.cents - c.total.cents, currency: c.total.currency };
  if (released.cents > 0) {
    lines.push({ label: 'Released to you', amount: usd(released), status: e.captures.balance ? 'done' : 'pending', detail: 'The rest of the hold, never charged' });
  }
  return lines;
}

/** One line per call result, for the grid and the timeline. */
export function callResult(row: CallRow): string {
  if (row.status === 'calling') return row.quote ? `On the call: ${row.quote.price ? usd(row.quote.price) : 'no price yet'}` : 'On the call';
  if (row.status === 'retry') return `No answer; calling again${row.retryAt ? ` at ${time(row.retryAt)}` : ''}`;
  switch (row.result) {
    case 'quoted':
      return `Quoted ${usd(row.quote?.price)}${row.quote?.readyAt ? `, ready ${row.quote.readyAt}` : ''}`;
    case 'unavailable':
      return "Doesn't have it";
    case 'no_quote':
      return 'No quote (voicemail or hung up)';
    case 'opted_out':
      return 'Asked not to be called by an AI';
    case 'no_answer':
      return 'No answer';
    case 'busy':
      return 'Busy';
    case 'call_failed':
      return "Call didn't go through";
    case 'timed_out':
      return 'No report from the call';
    case 'confirmed':
      return 'Confirmed the order';
    case 'not_confirmed':
      return "Didn't confirm";
    default:
      return row.result ?? '';
  }
}

export function callColor(row: CallRow): string {
  if (row.status !== 'ended') return 'blue';
  return ({ quoted: 'green', confirmed: 'teal', unavailable: 'gray', no_quote: 'gray', opted_out: 'orange', no_answer: 'light-gray', busy: 'light-gray', call_failed: 'red', timed_out: 'orange', not_confirmed: 'orange' } as Record<string, string>)[row.result ?? ''] ?? 'gray';
}

export interface TimelineData {
  resources: Array<{ id: string; name: string }>;
  events: Array<{ id: string; resourceId: string; name: string; startDate: Date; endDate: Date; eventColor: string }>;
  start: Date;
  end: Date;
}

/** Shops as rows, calls as bars; a live call runs to now. */
export function timeline(view: ErrandView, now: Date): TimelineData {
  const shops = view.outreach.plan?.shops ?? [];
  const resources = shops.map((s) => ({ id: s.businessId, name: s.name }));
  const events = view.outreach.rows
    .filter((r) => r.startedAt)
    .map((r) => {
      const startDate = new Date(r.startedAt!);
      const endRaw = r.endedAt ? new Date(r.endedAt) : now;
      const endDate = new Date(Math.max(endRaw.getTime(), startDate.getTime() + 30_000));
      return { id: r.id, resourceId: r.businessId, name: `${r.round === 2 ? 'Confirm' : 'Quote'}${r.attempt > 1 ? ` (try ${r.attempt})` : ''}: ${callResult(r)}`, startDate, endDate, eventColor: callColor(r) };
    });
  const times = events.flatMap((e) => [e.startDate.getTime(), e.endDate.getTime()]);
  const first = times.length ? Math.min(...times) : now.getTime();
  const last = times.length ? Math.max(...times, now.getTime()) : now.getTime() + 10 * 60_000;
  return { resources, events, start: new Date(first - 2 * 60_000), end: new Date(Math.max(last + 3 * 60_000, first + 15 * 60_000)) };
}

/** The confirmation call's reading of the contract, if there is one yet. */
export function confirmation(view: ErrandView): CallRow | undefined {
  const contract = view.errand.contract;
  return view.outreach.rows.find((r) => r.round === 2 && r.result === 'confirmed' && (!contract || r.businessId === contract.businessId));
}

export function needsReview(review: Review): boolean {
  return !review.agreed || review.mismatches.length > 0 || review.unverified.length > 0;
}

export function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
