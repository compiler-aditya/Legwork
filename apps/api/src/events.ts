import type { WebhookEvent } from '@legwork/paypal';

/**
 * Where verified webhook events are recorded. The event id is the duplicate
 * guard: PayPal retries a delivery for up to 3 days until it gets a 2xx, so
 * the same event can arrive more than once.
 */
export interface EventStore {
  /** Records the event; returns false when it was already recorded. */
  recordOnce(source: 'paypal' | 'elevenlabs' | 'twilio', event: WebhookEvent): Promise<boolean>;
}

/** For tests and local runs. Production uses the webhook_events table in Postgres. */
export class MemoryEventStore implements EventStore {
  readonly events = new Map<string, WebhookEvent>();

  async recordOnce(source: string, event: WebhookEvent): Promise<boolean> {
    const key = `${source}:${event.id}`;
    if (this.events.has(key)) return false;
    this.events.set(key, event);
    return true;
  }
}
