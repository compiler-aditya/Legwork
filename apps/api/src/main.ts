// The API as a long-running server (local runs, Render). Vercel uses vercel.ts instead.
import { createApp } from './app';

const { app, status } = await createApp({ env: process.env });

app.log.info(`storage: ${status.storage}${status.migrationsApplied.length ? ` (applied ${status.migrationsApplied.join(', ')})` : ''}`);
app.log.info(`paypal: ${status.paypal.client ? `on (${status.paypal.env})` : 'off (set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET)'}, webhooks ${status.paypal.webhook ? 'on' : 'off (set PAYPAL_WEBHOOK_ID)'}`);
app.log.info(`voice: ${status.voice ? 'on' : 'off (set ELEVENLABS_WEBHOOK_SECRET and CALL_TOKEN_SECRET)'}`);
if (status.storage === 'memory') app.log.warn('errands are kept in memory and lost on restart; set DATABASE_URL to keep them');

const port = Number(process.env.PORT ?? 3001);
app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
