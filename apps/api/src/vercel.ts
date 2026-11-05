/**
 * The API as one Vercel Function. scripts/vercel/build.mjs bundles this file
 * with everything it imports, and routes every path here.
 *
 * Work after a reply (handling a PayPal webhook, starting a deposit) runs
 * under waitUntil, so Vercel keeps the function alive until it finishes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachDatabasePool, waitUntil } from '@vercel/functions';
import { createApp } from './app';

const ready = createApp({
  env: process.env,
  background: (task) => waitUntil(task()),
  migrationsDir: join(dirname(fileURLToPath(import.meta.url)), 'migrations'),
  onPool: (pool) => attachDatabasePool(pool),
}).then(async ({ app }) => {
  await app.ready();
  return app;
});

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await ready;
  await new Promise<void>((resolve) => {
    res.on('finish', resolve);
    res.on('close', resolve);
    app.server.emit('request', req, res);
  });
}
