import {
  authorizeOrder,
  cancelPayoutItem,
  captureAuthorization,
  createHoldOrder,
  createPayout,
  createVaultedHold,
  refundCapture,
  voidAuthorization,
  type Capture,
  type CaptureInput,
  type CreatePayoutInput,
  type HoldOrderInput,
  type Order,
  type PayoutBatchHeader,
  type PayoutItem,
  type PayPalClient,
  type Refund,
  type VaultedHoldInput,
} from '@legwork/paypal';
import type { Money } from '@legwork/core';
import type { Errand, MoneyStep, Transition } from './model';

/** Every PayPal call the orchestrator makes. Production binds it to the PayPal client; tests use a fake. */
export interface PaymentsPort {
  createHoldOrder(input: HoldOrderInput, requestId: string): Promise<Order>;
  authorizeOrder(orderId: string, requestId: string): Promise<Order>;
  createVaultedHold(input: VaultedHoldInput, requestId: string): Promise<Order>;
  captureAuthorization(authorizationId: string, input: CaptureInput, requestId: string): Promise<Capture>;
  voidAuthorization(authorizationId: string, requestId: string): Promise<void>;
  refundCapture(captureId: string, input: { amount?: Money; noteToPayer?: string }, requestId: string): Promise<Refund>;
  createPayout(input: CreatePayoutInput, requestId: string): Promise<{ batch_header: PayoutBatchHeader }>;
  cancelPayoutItem(payoutItemId: string): Promise<PayoutItem>;
}

export function paypalPayments(client: PayPalClient): PaymentsPort {
  return {
    createHoldOrder: (input, requestId) => createHoldOrder(client, input, requestId),
    authorizeOrder: (orderId, requestId) => authorizeOrder(client, orderId, requestId),
    createVaultedHold: (input, requestId) => createVaultedHold(client, input, requestId),
    captureAuthorization: (id, input, requestId) => captureAuthorization(client, id, input, requestId),
    voidAuthorization: (id, requestId) => voidAuthorization(client, id, requestId),
    refundCapture: (id, input, requestId) => refundCapture(client, id, input, requestId),
    createPayout: (input, requestId) => createPayout(client, input, requestId),
    cancelPayoutItem: (id) => cancelPayoutItem(client, id),
  };
}

/** Errand storage. Postgres in production (packages/db); memory in tests and local runs. */
export interface ErrandRepo {
  get(errandId: string): Promise<Errand | undefined>;
  save(errand: Errand): Promise<void>;
  appendTransition(t: Transition): Promise<void>;
  appendMoneyStep(step: MoneyStep): Promise<void>;
  markMoneyStep(requestId: string, patch: Pick<MoneyStep, 'status'> & { paypalId?: string }): Promise<void>;
  /** Runs fn while no other process works on this errand. Optional: memory repos rely on the in-process queue. */
  withLock?<T>(errandId: string, fn: () => Promise<T>): Promise<T>;
}

export class MemoryErrandRepo implements ErrandRepo {
  readonly errands = new Map<string, Errand>();
  readonly transitions: Transition[] = [];
  readonly moneySteps: MoneyStep[] = [];

  async get(errandId: string) {
    const e = this.errands.get(errandId);
    return e ? structuredClone(e) : undefined;
  }
  async save(errand: Errand) {
    this.errands.set(errand.id, structuredClone(errand));
  }
  async appendTransition(t: Transition) {
    this.transitions.push(t);
  }
  async appendMoneyStep(step: MoneyStep) {
    if (this.moneySteps.some((s) => s.requestId === step.requestId)) {
      throw new Error(`Money step ${step.requestId} already exists`);
    }
    this.moneySteps.push({ ...step });
  }
  async markMoneyStep(requestId: string, patch: Pick<MoneyStep, 'status'> & { paypalId?: string }) {
    const step = this.moneySteps.find((s) => s.requestId === requestId);
    if (step) Object.assign(step, patch);
  }
}
