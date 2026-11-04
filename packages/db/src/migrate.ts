import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Database } from './database';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/**
 * Applies every migrations/*.sql not applied yet, in name order, each in its
 * own transaction. Safe to run from several instances at once: they queue on a lock.
 * Returns the names it applied.
 */
export async function migrate(db: Database, dir = MIGRATIONS_DIR): Promise<string[]> {
  return db.withLock('legwork:migrate', async () => {
    await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const name of files) {
      if (done.has(name)) continue;
      const script = await readFile(join(dir, name), 'utf8');
      await db.transaction(async (tx) => {
        await tx.exec(script);
        await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      });
      applied.push(name);
    }
    return applied;
  });
}
