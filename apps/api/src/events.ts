import type { WebhookEvent } from '@legwork/paypal';

export type WebhookSource = 'paypal' | 'elevenlabs' | 'twilio';

/**
 * Where verified webhook events are recorded. The event id is the duplicate
 * guard: PayPal retries a delivery for up to 3 days until it gets a 2xx, so
 * the same event can arrive more than once. Production uses PgEventStore
 * (@legwork/db), over the webhook_events table.
 */
export interface EventStore {
  /** Records the event; true when it still needs handling (new, or an earlier copy's handler never finished). */
  claim(source: WebhookSource, event: WebhookEvent): Promise<boolean>;
  /** Called once the handler has finished; later copies are then duplicates. */
  markProcessed(source: WebhookSource, eventId: string): Promise<void>;
}

/** For tests and local runs. */
export class MemoryEventStore implements EventStore {
  readonly events = new Map<string, { event: WebhookEvent; processed: boolean }>();

  async claim(source: WebhookSource, event: WebhookEvent): Promise<boolean> {
    const key = `${source}:${event.id}`;
    const seen = this.events.get(key);
    if (seen?.processed) return false;
    if (!seen) this.events.set(key, { event, processed: false });
    return true;
  }

  async markProcessed(source: WebhookSource, eventId: string): Promise<void> {
    const seen = this.events.get(`${source}:${eventId}`);
    if (seen) seen.processed = true;
  }
}
