import { Pool, type PoolClient } from 'pg'
import { ensureSchema } from '../../db'

// Shared test-DB harness. Tests SKIP cleanly when TEST_DATABASE_URL is unset
// (CI doesn't need to fail just because there's no Postgres available).

let pool: Pool | null = null

export function hasTestDb(): boolean {
  return !!process.env.TEST_DATABASE_URL
}

export async function getTestDb(): Promise<PoolClient> {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL not set')
  if (!pool) pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 })
  const client = await pool.connect()
  await ensureSchema(client)
  return client
}

export async function closeTestPool(): Promise<void> {
  if (pool) { await pool.end(); pool = null }
}

// Wipe just the memory_* tables so each test starts clean. Leaves Lila's
// other tables alone — assume the test DB is dedicated.
export async function resetMemory(db: PoolClient): Promise<void> {
  await db.query(`DELETE FROM memory_episodes`)
  await db.query(`DELETE FROM memory_summaries`)
  await db.query(`DELETE FROM memory_messages`)
  await db.query(`DELETE FROM memory_short`)
  await db.query(`DELETE FROM memory_medium`)
  await db.query(`DELETE FROM memory_long`)
  await db.query(`DELETE FROM memory_entities`)
  await db.query(`UPDATE memory_state SET counter = 0,
    last_decay_short_at = NULL, last_decay_medium_at = NULL, last_decay_long_at = NULL,
    last_rollup_hour_at = NULL, last_rollup_day_at = NULL, last_rollup_week_at = NULL
    WHERE id = 1`)
}
