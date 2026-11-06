import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';
import type { PGlite } from '@electric-sql/pglite';

export interface Queryable {
  query<T extends object = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs a script of several statements (migrations). */
  exec(script: string): Promise<void>;
}

/** The little of Postgres Legwork needs, over node-postgres in production and PGlite in tests. */
export interface Database extends Queryable {
  /** Runs fn inside BEGIN/COMMIT on one connection, rolling back if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Runs fn while holding a lock named key; another process asking for the same key waits. */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * node-postgres. withLock takes a session advisory lock on a pooled connection
 * and every query inside fn runs on that same connection, so a locked section
 * uses exactly one connection and lock holders never wait on the pool.
 */
export function pgDatabase(pool: pg.Pool): Database {
  // The connection a locked section runs on, and the lock keys it holds.
  const held = new AsyncLocalStorage<{ client: pg.PoolClient; keys: Set<string> }>();
  const on = (c: pg.Pool | pg.PoolClient): Queryable => ({
    query: async <T extends object>(text: string, params?: unknown[]) => ({ rows: (await c.query(text, params)).rows as T[] }),
    exec: async (script) => {
      await c.query(script);
    },
  });
  const current = () => on(held.getStore()?.client ?? pool);

  return {
    query: (text, params) => current().query(text, params),
    exec: (script) => current().exec(script),

    async transaction(fn) {
      const inLock = held.getStore()?.client;
      const client = inLock ?? (await pool.connect());
      try {
        await client.query('BEGIN');
        const result = await fn(on(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        if (!inLock) client.release();
      }
    },

    async withLock(key, fn) {
      const ctx = held.getStore();
      if (ctx?.keys.has(key)) return fn();
      if (ctx) {
        // A different key inside a locked section: take it on the same session.
        await ctx.client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
        ctx.keys.add(key);
        try {
          return await fn();
        } finally {
          ctx.keys.delete(key);
          await ctx.client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
        }
      }
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
        try {
          return await held.run({ client, keys: new Set([key]) }, fn);
        } finally {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]).catch((err: Error) => {
            broken = err;
          });
        }
      } finally {
        // A connection that could not unlock is discarded, which ends its session and frees the lock.
        client.release(broken ?? false);
      }
    },

    close: () => pool.end(),
  };
}

/**
 * PGlite: Postgres compiled to WebAssembly, in process. It has one session, so
 * withLock only runs fn; the orchestrator's in-process queue does the locking.
 */
export function pgliteDatabase(db: PGlite): Database {
  return {
    query: async <T extends object>(text: string, params?: unknown[]) => ({ rows: (await db.query<T>(text, params)).rows }),
    exec: async (script) => {
      await db.exec(script);
    },
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          query: async <T extends object>(text: string, params?: unknown[]) => ({ rows: (await tx.query<T>(text, params)).rows }),
          exec: async (script) => {
            await tx.exec(script);
          },
        }),
      ),
    withLock: (_key, fn) => fn(),
    close: () => db.close(),
  };
}
