import {
  DEFAULT_RULES,
  assertCaptureAllowed,
  depositFor,
  fitsHold,
  fromPayPal,
  newPickupCode,
  nextState,
  requestIdFor,
  senderItemIdFor,
  subtract,
  usd,
  type ErrandEvent,
  type Money,
  type MoneyRules,
  type MoneyStep as StepName,
} from '@legwork/core';
import { approveLink, authorizationOf, type WebhookEvent } from '@legwork/paypal';
import type { Contract, Deal, Errand, ErrandRequest, MoneyKind, PayoutStatus } from './model';
import type { ErrandRepo, PaymentsPort } from './ports';

export interface ErrandMoneyOptions {
  payments: PaymentsPort;
  repo: ErrandRepo;
  rules?: MoneyRules;
  pickupCode?: () => string;
}

export type ConfirmResult =
  | { ok: true; contractId: string; pickupCode: string; deposit: Money }
  | { ok: false; reason: string };

export class ErrandMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErrandMoneyError';
  }
}

const PAYOUT_EVENTS: Record<string, PayoutStatus> = {
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED': 'SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED': 'UNCLAIMED',
  'PAYMENT.PAYOUTS-ITEM.CANCELED': 'CANCELED',
  'PAYMENT.PAYOUTS-ITEM.RETURNED': 'RETURNED',
  'PAYMENT.PAYOUTS-ITEM.FAILED': 'FAILED',
  'PAYMENT.PAYOUTS-ITEM.BLOCKED': 'BLOCKED',
  'PAYMENT.PAYOUTS-ITEM.DENIED': 'DENIED',
};

/**
 * The only code in Legwork that moves money. Agents and tools call these
 * methods; they never touch PayPal themselves. Each step:
 *   1. asks the errand state machine (@legwork/core) whether it may happen,
 *   2. checks the money rules (never more than the approved contract),
 *   3. calls PayPal with an idempotency key derived from the errand and step,
 *   4. waits for PayPal's verified webhook before the errand moves on.
 *
 * Calls for one errand run one at a time: an in-process queue, plus the
 * repo's lock when it has one (the Postgres repo takes an advisory lock, so
 * several API instances and workflow workers can share errands).
 */
export class ErrandMoney {
  private readonly payments: PaymentsPort;
  private readonly repo: ErrandRepo;
  private readonly rules: MoneyRules;
  private readonly pickupCode: () => string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(opts: ErrandMoneyOptions) {
    this.payments = opts.payments;
    this.repo = opts.repo;
    this.rules = opts.rules ?? DEFAULT_RULES;
    this.pickupCode = opts.pickupCode ?? newPickupCode;
  }

  // ---- errand set-up -------------------------------------------------------

  async createErrand(input: { id: string; userId: string; request: ErrandRequest; budgetMax: Money }): Promise<Errand> {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(input.id)) throw new ErrandMoneyError(`Errand ids must be 1-40 letters, digits, _ or -: ${input.id}`);
    if (await this.repo.get(input.id)) throw new ErrandMoneyError(`Errand ${input.id} already exists`);
    const errand: Errand = {
      id: input.id,
      userId: input.userId,
      request: input.request,
      state: 'requested',
      budgetMax: input.budgetMax,
      captures: {},
      payouts: {},
      cancelledContracts: [],
    };
    await this.repo.save(errand);
    return errand;
  }

  /** Moves an errand on for events that carry no money (planning done, quotes started, best chosen...). */
  advance(errandId: string, event: Extract<ErrandEvent, 'PLAN_READY' | 'QUOTES_STARTED' | 'QUOTES_DONE' | 'BEST_CHOSEN' | 'SHOP_DECLINED' | 'PICKUP_SCHEDULED'>, cause: string): Promise<Errand> {
    return this.locked(errandId, async (errand) => {
      await this.move(errand, event, cause);
      return errand;
    });
  }

  // ---- the budget hold -----------------------------------------------------

  /** Creates the AUTHORIZE order for the buyer's maximum and returns the link the buyer approves. */
  requestHold(errandId: string, opts: { returnUrl: string; cancelUrl: string; savePayPal: boolean; description: string }): Promise<{ orderId: string; approveUrl: string }> {
    return this.locked(errandId, async (errand) => {
      await this.move(errand, 'HOLD_REQUESTED', 'buyer started the errand');
      const order = await this.payments.createHoldOrder(
        { amount: errand.budgetMax, referenceId: errand.id, description: opts.description, returnUrl: opts.returnUrl, cancelUrl: opts.cancelUrl, savePayPal: opts.savePayPal },
        requestIdFor(errand.id, 'hold'),
      );
      const approveUrl = approveLink(order);
      if (!approveUrl) throw new ErrandMoneyError(`PayPal returned no approve link for order ${order.id}`);
      errand.hold = { orderId: order.id, remaining: errand.budgetMax };
      await this.repo.save(errand);
      return { orderId: order.id, approveUrl };
    });
  }

  /** After the buyer approves in PayPal. The errand moves on only when PAYMENT.AUTHORIZATION.CREATED arrives. */
  buyerApproved(errandId: string): Promise<{ authorizationId: string }> {
    return this.locked(errandId, async (errand) => {
      if (errand.state !== 'hold_pending' || !errand.hold) throw new ErrandMoneyError(`Errand ${errandId} is not waiting for approval`);
      const order = await this.payments.authorizeOrder(errand.hold.orderId, requestIdFor(errand.id, 'authorize'));
      const auth = authorizationOf(order);
      if (!auth) throw new ErrandMoneyError(`Order ${errand.hold.orderId} authorized without an authorization`);
      errand.hold.authorizationId = auth.id;
      await this.repo.save(errand);
      await this.step(errand, 'authorize', 'authorize', errand.budgetMax, auth.id);
      return { authorizationId: auth.id };
    });
  }

  // ---- the deal ------------------------------------------------------------

  /**
   * Called by the voice agent's confirm_order tool on the round-2 call. Refuses
   * anything that does not fit what PayPal still holds; the agent tells the
   * shop it cannot agree to that price.
   */
  confirmDeal(errandId: string, deal: Deal): Promise<ConfirmResult> {
    return this.locked(errandId, async (errand) => {
      if (errand.state !== 'confirming') return { ok: false, reason: `errand is ${errand.state}, not confirming` };
      if (!errand.hold?.authorizationId) return { ok: false, reason: 'no confirmed hold' };
      if (!Number.isInteger(deal.quantity) || deal.quantity < 1) return { ok: false, reason: 'quantity must be a whole number above zero' };
      if (!fitsHold(deal.total, errand.hold.remaining)) {
        return { ok: false, reason: `price is above the ${format(errand.hold.remaining)} held for this errand` };
      }
      const seq = errand.cancelledContracts.length;
      const contract: Contract = {
        id: `${errand.id}-c${seq + 1}`,
        businessId: deal.businessId,
        outreachId: deal.outreachId,
        item: deal.item,
        quantity: deal.quantity,
        total: deal.total,
        deposit: depositFor(deal.total, this.rules),
        pickupCode: this.pickupCode(),
        payout: deal.payout,
        pickupAt: deal.pickupAt,
      };
      errand.contract = contract;
      await this.move(errand, 'CONTRACT_CONFIRMED', `confirm_order on ${deal.outreachId}`);
      return { ok: true, contractId: contract.id, pickupCode: contract.pickupCode, deposit: contract.deposit };
    });
  }

  /** Captures the deposit from the hold. The payout to the shop follows PayPal's capture webhook. */
  payDeposit(errandId: string): Promise<Errand> {
    return this.locked(errandId, async (errand) => {
      const { contract, authorizationId, seq } = this.contractInPlay(errand);
      await this.move(errand, 'DEPOSIT_REQUESTED', 'contract confirmed');
      if (contract.deposit.cents === 0) {
        await this.move(errand, 'DEPOSIT_CAPTURED', 'no deposit under the minimum');
        return errand;
      }
      assertCaptureAllowed({ contractTotal: contract.total, hold: this.coverage(errand), capturedSoFar: usd(0), amount: contract.deposit });
      const requestId = requestIdFor(errand.id, 'capture-deposit', seq);
      const capture = await this.payments.captureAuthorization(
        authorizationId,
        { amount: contract.deposit, finalCapture: false, invoiceId: `${errand.id}-deposit-${seq}` },
        requestId,
      );
      errand.captures.deposit = capture.id;
      errand.hold!.remaining = subtract(errand.hold!.remaining, contract.deposit);
      await this.repo.save(errand);
      await this.step(errand, 'capture_deposit', 'capture-deposit', contract.deposit, capture.id, seq);
      return errand;
    });
  }

  /** The shop read back the code at pickup: capture the balance, which releases the rest of the hold. */
  confirmPickupCode(errandId: string, code: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.locked(errandId, async (errand) => {
      const { contract, authorizationId, seq } = this.contractInPlay(errand);
      if (errand.state !== 'awaiting_pickup') return { ok: false, reason: `errand is ${errand.state}, not awaiting pickup` };
      if (code.trim() !== contract.pickupCode) return { ok: false, reason: 'pickup code does not match' };
      await this.move(errand, 'CODE_CONFIRMED', 'shop read back the pickup code');
      const balance = subtract(contract.total, contract.deposit);
      assertCaptureAllowed({ contractTotal: contract.total, hold: this.coverage(errand), capturedSoFar: contract.deposit, amount: balance });
      const capture = await this.payments.captureAuthorization(
        authorizationId,
        { amount: balance, finalCapture: true, invoiceId: `${errand.id}-balance-${seq}` },
        requestIdFor(errand.id, 'capture-balance', seq),
      );
      errand.captures.balance = capture.id;
      errand.hold!.remaining = usd(0); // a final capture releases whatever was left
      await this.repo.save(errand);
      await this.step(errand, 'capture_balance', 'capture-balance', balance, capture.id, seq);
      return { ok: true };
    });
  }

  // ---- when it goes wrong -------------------------------------------------

  /** No quote was good enough: release the whole hold. */
  noDeal(errandId: string, cause: string): Promise<Errand> {
    return this.locked(errandId, async (errand) => {
      await this.move(errand, 'NO_GOOD_QUOTE', cause);
      const authId = errand.hold?.authorizationId;
      if (!authId) throw new ErrandMoneyError(`Errand ${errandId} has no authorization to void`);
      await this.payments.voidAuthorization(authId, requestIdFor(errand.id, 'void'));
      await this.step(errand, 'void', 'void', errand.hold!.remaining, authId);
      return errand;
    });
  }

  /**
   * The shop cancelled after agreeing. The deposit goes back to the buyer;
   * an unclaimed payout is cancelled; one the shop already claimed is
   * flagged (Legwork absorbs it in v1). The hold stays for the next shop.
   */
  shopCancelled(errandId: string, cause: string): Promise<Errand> {
    return this.locked(errandId, async (errand) => {
      const contract = errand.contract;
      if (!contract) throw new ErrandMoneyError(`Errand ${errandId} has no contract to cancel`);
      const seq = errand.cancelledContracts.length;
      await this.move(errand, 'SHOP_CANCELLED', cause);

      const depositCapture = errand.captures.deposit;
      if (depositCapture) {
        const refund = await this.payments.refundCapture(
          depositCapture,
          { amount: contract.deposit, noteToPayer: 'The shop cancelled; your deposit is refunded.' },
          requestIdFor(errand.id, 'refund-deposit', seq),
        );
        await this.step(errand, 'refund', 'refund-deposit', contract.deposit, refund.id, seq);
      }
      const payout = errand.payouts.deposit;
      if (payout?.status === 'UNCLAIMED' && payout.itemId) {
        const cancelled = await this.payments.cancelPayoutItem(payout.itemId);
        payout.status = (cancelled.transaction_status as PayoutStatus | undefined) ?? 'CANCELED';
      } else if (payout && payout.status !== 'CANCELED' && payout.status !== 'RETURNED' && payout.status !== 'FAILED') {
        errand.attention = `Deposit payout ${payout.batchId} was ${payout.status} when ${contract.businessId} cancelled; recover it from the shop or absorb it.`;
      }

      errand.cancelledContracts.push(contract);
      errand.contract = undefined;
      errand.captures = {};
      errand.payouts = {};
      await this.repo.save(errand);
      return errand;
    });
  }

  // ---- PayPal webhooks -----------------------------------------------------

  /**
   * Routes a verified PayPal event to its errand. Unknown, duplicate or late
   * events are ignored: the state machine refuses any step that does not fit.
   */
  async handlePayPalEvent(event: WebhookEvent): Promise<string> {
    const r = event.resource as Record<string, any>;
    const type = event.event_type;

    if (type === 'PAYMENT.AUTHORIZATION.CREATED' || type === 'PAYMENT.AUTHORIZATION.VOIDED') {
      const errandId = typeof r.custom_id === 'string' ? r.custom_id : undefined;
      if (!errandId) return 'ignored: authorization without custom_id';
      return this.locked(errandId, async (errand) => {
        if (type === 'PAYMENT.AUTHORIZATION.CREATED') {
          if (errand.state !== 'hold_pending') return `ignored: errand is ${errand.state}`;
          if (errand.hold && !errand.hold.authorizationId) errand.hold.authorizationId = String(r.id);
          if (errand.hold?.authorizationId !== r.id) return `ignored: authorization ${r.id} is not this errand's`;
          await this.repo.markMoneyStep(requestIdFor(errand.id, 'authorize'), { status: 'confirmed', paypalId: String(r.id) });
          await this.move(errand, 'HOLD_CONFIRMED', event.id);
          return 'hold confirmed';
        }
        if (errand.state !== 'releasing') return `ignored: errand is ${errand.state}`;
        await this.repo.markMoneyStep(requestIdFor(errand.id, 'void'), { status: 'confirmed' });
        errand.hold!.remaining = usd(0);
        await this.move(errand, 'HOLD_RELEASED', event.id);
        return 'hold released';
      });
    }

    if (type === 'PAYMENT.CAPTURE.COMPLETED' || type === 'PAYMENT.CAPTURE.DENIED') {
      const m = /^(.+)-(deposit|balance)-(\d+)$/.exec(String(r.invoice_id ?? ''));
      if (!m) return 'ignored: capture without a Legwork invoice id';
      const [, errandId, kind, seqText] = m as unknown as [string, string, 'deposit' | 'balance', string];
      const seq = Number(seqText);
      return this.locked(errandId, async (errand) => {
        if (seq !== errand.cancelledContracts.length) return 'ignored: capture for an earlier contract';
        const stepName: StepName = kind === 'deposit' ? 'capture-deposit' : 'capture-balance';
        if (type === 'PAYMENT.CAPTURE.DENIED') {
          await this.repo.markMoneyStep(requestIdFor(errand.id, stepName, seq), { status: 'failed', paypalId: String(r.id) });
          errand.attention = `PayPal denied the ${kind} capture ${r.id}; place a new hold from saved PayPal or ask the buyer.`;
          await this.repo.save(errand);
          return `${kind} capture denied`;
        }
        if (kind === 'deposit') {
          if (errand.state !== 'deposit_pending') return `ignored: errand is ${errand.state}`;
          errand.captures.deposit ??= String(r.id);
          await this.repo.markMoneyStep(requestIdFor(errand.id, stepName, seq), { status: 'confirmed', paypalId: String(r.id) });
          await this.move(errand, 'DEPOSIT_CAPTURED', event.id);
          await this.payShop(errand, 'deposit', seq);
          return 'deposit captured, shop paid';
        }
        if (errand.state !== 'settling') return `ignored: errand is ${errand.state}`;
        errand.captures.balance ??= String(r.id);
        await this.repo.markMoneyStep(requestIdFor(errand.id, stepName, seq), { status: 'confirmed', paypalId: String(r.id) });
        await this.move(errand, 'BALANCE_CAPTURED', event.id);
        await this.payShop(errand, 'balance', seq);
        return 'balance captured, shop paid';
      });
    }

    const payoutStatus = PAYOUT_EVENTS[type];
    if (payoutStatus) {
      const senderItemId = String(r.payout_item?.sender_item_id ?? '');
      const m = /^lw-(.+)-payout-(deposit|balance)(?:-\d+)?$/.exec(senderItemId);
      if (!m) return 'ignored: payout without a Legwork sender item id';
      const [, errandId, kind] = m as unknown as [string, string, 'deposit' | 'balance'];
      return this.locked(errandId, async (errand) => {
        const payout = errand.payouts[kind];
        if (!payout || payout.senderItemId !== senderItemId) return 'ignored: payout for an earlier contract';
        payout.itemId ??= typeof r.payout_item_id === 'string' ? r.payout_item_id : undefined;
        payout.status = payoutStatus;
        const seq = errand.cancelledContracts.length;
        const step: StepName = kind === 'deposit' ? 'payout-deposit' : 'payout-balance';
        const final = payoutStatus === 'SUCCEEDED' ? 'confirmed' : payoutStatus === 'UNCLAIMED' ? undefined : 'failed';
        if (final) await this.repo.markMoneyStep(requestIdFor(errand.id, step, seq), { status: final, paypalId: payout.itemId });
        if (final === 'failed') errand.attention = `${kind} payout ${payoutStatus.toLowerCase()} for ${errand.contract?.businessId ?? 'the shop'}; pay them another way.`;
        await this.repo.save(errand);
        return `${kind} payout ${payoutStatus}`;
      });
    }

    return `ignored: ${type}`;
  }

  // ---- internals -----------------------------------------------------------

  private async payShop(errand: Errand, kind: 'deposit' | 'balance', seq: number): Promise<void> {
    const contract = errand.contract;
    if (!contract) throw new ErrandMoneyError(`Errand ${errand.id} has no contract to pay`);
    const amount = kind === 'deposit' ? contract.deposit : subtract(contract.total, contract.deposit);
    const step: StepName = kind === 'deposit' ? 'payout-deposit' : 'payout-balance';
    const senderItemId = `${senderItemIdFor(errand.id, step)}${seq ? `-${seq}` : ''}`;
    const created = await this.payments.createPayout(
      {
        senderBatchId: senderItemId,
        emailSubject: kind === 'deposit' ? 'Deposit for your Legwork order' : 'Payment for your Legwork order',
        items: [
          {
            recipientType: contract.payout.type,
            receiver: contract.payout.receiver,
            wallet: contract.payout.wallet,
            amount,
            senderItemId,
            note: `${kind === 'deposit' ? 'Deposit' : 'Balance'} for ${contract.quantity} x ${contract.item}, pickup code ${contract.pickupCode}`.slice(0, 4000),
          },
        ],
      },
      requestIdFor(errand.id, step, seq),
    );
    errand.payouts[kind] = { batchId: created.batch_header.payout_batch_id, senderItemId, status: 'sent' };
    await this.repo.save(errand);
    await this.step(errand, kind === 'deposit' ? 'payout_deposit' : 'payout_balance', step, amount, created.batch_header.payout_batch_id, seq);
  }

  private contractInPlay(errand: Errand): { contract: Contract; authorizationId: string; seq: number } {
    const contract = errand.contract;
    const authorizationId = errand.hold?.authorizationId;
    if (!contract) throw new ErrandMoneyError(`Errand ${errand.id} has no contract`);
    if (!authorizationId) throw new ErrandMoneyError(`Errand ${errand.id} has no authorization`);
    return { contract, authorizationId, seq: errand.cancelledContracts.length };
  }

  /** What the hold covers for the current contract: what PayPal still holds plus what this contract already captured. */
  private coverage(errand: Errand): Money {
    const remaining = errand.hold?.remaining ?? usd(0);
    const capturedForContract = errand.captures.deposit && errand.contract ? errand.contract.deposit : usd(0);
    return usd(remaining.cents + capturedForContract.cents);
  }

  private async move(errand: Errand, event: ErrandEvent, cause: string): Promise<void> {
    const from = errand.state;
    const to = nextState(from, event);
    errand.state = to;
    await this.repo.save(errand);
    await this.repo.appendTransition({ errandId: errand.id, from, event, to, cause });
  }

  private async step(errand: Errand, kind: MoneyKind, name: StepName, amount: Money, paypalId: string, seq = 0): Promise<void> {
    await this.repo.appendMoneyStep({ requestId: requestIdFor(errand.id, name, seq), errandId: errand.id, kind, amount, status: 'sent', paypalId });
  }

  private async locked<T>(errandId: string, fn: (errand: Errand) => Promise<T>): Promise<T> {
    const previous = this.locks.get(errandId) ?? Promise.resolve();
    const body = async () => {
      const errand = await this.repo.get(errandId);
      if (!errand) throw new ErrandMoneyError(`No errand ${errandId}`);
      return fn(errand);
    };
    const run = previous.catch(() => undefined).then(() => (this.repo.withLock ? this.repo.withLock(errandId, body) : body()));
    this.locks.set(errandId, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(errandId) === run) this.locks.delete(errandId);
    }
  }
}

function format(m: Money): string {
  return `$${(m.cents / 100).toFixed(2)}`;
}

/** Reads a PayPal amount from a webhook resource, for logging and reconciliation. */
export function amountOf(resource: { amount?: { value?: string; currency_code?: string } }): Money | undefined {
  const a = resource.amount;
  return a?.value && a.currency_code ? fromPayPal(a.value, a.currency_code) : undefined;
}
