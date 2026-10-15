import fs from 'node:fs';
import path from 'node:path';
import { Pool, types } from 'pg';

// bigint -> number (safe: all limits and totals are capped well below 2^53), date -> 'YYYY-MM-DD' string.
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1082, (v) => v);

export function createPool(connectionString: string, max = 20): Pool {
  return new Pool({ connectionString, max });
}

/** Applies SQL files from ./migrations once each, safely even if several instances start together. */
export async function migrate(pool: Pool, dir = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), 'migrations')) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
}

export function periodOf(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
