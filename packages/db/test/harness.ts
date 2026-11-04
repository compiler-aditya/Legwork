import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { pgDatabase, pgliteDatabase, type Database } from '../src';

export interface TestDatabase {
  db: Database;
  /** True against a real Postgres server (TEST_DATABASE_URL), false for in-process PGlite. */
  real: boolean;
  /** A second, independent connection pool to the same data, standing in for another process. */
  another?: () => Database;
  close(): Promise<void>;
}

/**
 * A fresh database for one test file. With TEST_DATABASE_URL set, each call
 * gets its own schema on that server and drops it afterwards; otherwise PGlite.
 */
export async function openTestDatabase(): Promise<TestDatabase> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const lite = await PGlite.create();
    return { db: pgliteDatabase(lite), real: false, close: () => lite.close() };
  }
  const schema = `lw_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pools: pg.Pool[] = [];
  const open = () => {
    const pool = new pg.Pool({ connectionString: url, max: 5, options: `-c search_path=${schema}` });
    pools.push(pool);
    return pgDatabase(pool);
  };
  return {
    db: open(),
    real: true,
    another: open,
    async close() {
      await Promise.all(pools.map((p) => p.end()));
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}
