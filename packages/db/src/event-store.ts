import type { Database } from './database';

export type WebhookSource = 'paypal' | 'elevenlabs' | 'twilio';

export interface StoredEvent {
  id: string;
  event_type: string;
}

/**
 * Verified webhook deliveries, one row per (source, event id). PayPal retries
 * a delivery for up to 3 days until it gets a 2xx, so the same event arrives
 * more than once; only the first copy that finishes is handled.
 */
export class PgEventStore {
  constructor(private readonly db: Database) {}

  /**
   * Records the event. Returns true when it still needs handling: it is new,
   * or an earlier copy was recorded but its handler never finished.
   */
  async claim(source: WebhookSource, event: StoredEvent): Promise<boolean> {
    const { rows } = await this.db.query(
      `INSERT INTO webhook_events (source, event_id, event_type, verified, payload)
       VALUES ($1, $2, $3, true, $4::jsonb)
       ON CONFLICT (source, event_id) DO UPDATE SET event_type = EXCLUDED.event_type
         WHERE webhook_events.processed_at IS NULL
       RETURNING event_id`,
      [source, event.id, event.event_type, JSON.stringify(event)],
    );
    return rows.length > 0;
  }

  async markProcessed(source: WebhookSource, eventId: string): Promise<void> {
    await this.db.query(`UPDATE webhook_events SET processed_at = now() WHERE source = $1 AND event_id = $2`, [source, eventId]);
  }
}
