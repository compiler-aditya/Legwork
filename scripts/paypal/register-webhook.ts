/**
 * Registers the deployed API as this PayPal app's webhook, or updates the one
 * already registered at that URL, and prints PAYPAL_WEBHOOK_ID to set on the
 * deployment. Uses PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_ENV.
 *
 *   npm run paypal:webhook -- --url=https://legwork-api-five.vercel.app/webhooks/paypal
 */
import { PayPalClient, SUBSCRIBED_EVENTS, type PayPalEnv } from '@legwork/paypal';

try {
  process.loadEnvFile('.env');
} catch {
  // no .env: use the environment as it is
}

const url = process.argv.find((a) => a.startsWith('--url='))?.slice(6) ?? (process.env.PUBLIC_API_URL ? `${process.env.PUBLIC_API_URL.replace(/\/$/, '')}/webhooks/paypal` : undefined);
if (!url || !/^https:\/\/[^/]+\/webhooks\/paypal$/.test(url)) {
  console.error('Pass --url=https://<api host>/webhooks/paypal (PayPal only delivers to https on port 443).');
  process.exit(1);
}
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.');
  process.exit(1);
}
const env = (process.env.PAYPAL_ENV as PayPalEnv | undefined) ?? 'sandbox';
const client = new PayPalClient({ clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET, env });

// Subscribe only to event names PayPal offers, so a typo fails here and not silently.
const offered = await client.request<{ event_types: Array<{ name: string }> }>('GET', '/v1/notifications/webhooks-event-types');
const names = new Set(offered.event_types.map((e) => e.name));
const unknown = SUBSCRIBED_EVENTS.filter((n) => !names.has(n));
if (unknown.length) {
  console.error(`PayPal does not offer these events: ${unknown.join(', ')}`);
  process.exit(1);
}
const eventTypes = SUBSCRIBED_EVENTS.map((name) => ({ name }));

const { webhooks } = await client.request<{ webhooks: Array<{ id: string; url: string }> }>('GET', '/v1/notifications/webhooks');
const existing = webhooks.find((w) => w.url === url);
let id: string;
if (existing) {
  await client.request('PATCH', `/v1/notifications/webhooks/${existing.id}`, { body: [{ op: 'replace', path: '/event_types', value: eventTypes }] });
  id = existing.id;
  console.log(`Updated the ${env} webhook for ${url} (${SUBSCRIBED_EVENTS.length} events).`);
} else {
  const created = await client.request<{ id: string }>('POST', '/v1/notifications/webhooks', { body: { url, event_types: eventTypes } });
  id = created.id;
  console.log(`Registered a ${env} webhook for ${url} (${SUBSCRIBED_EVENTS.length} events).`);
}
console.log(`PAYPAL_WEBHOOK_ID=${id}`);
