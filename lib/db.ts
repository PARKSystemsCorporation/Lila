import { Pool, PoolClient } from 'pg'

declare global {
  // eslint-disable-next-line no-var
  var _pgPool: Pool | undefined
}

export function getPool(): Pool {
  if (!globalThis._pgPool) {
    globalThis._pgPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 })
  }
  return globalThis._pgPool
}

let schemaReady = false

export async function ensureSchema(client: PoolClient): Promise<void> {
  if (schemaReady) return
  await client.query(`
    CREATE TABLE IF NOT EXISTS lila_state (
      id           INTEGER     PRIMARY KEY DEFAULT 1,
      total_earned NUMERIC(12,2) NOT NULL DEFAULT 1247.50,
      active_tasks JSONB       NOT NULL DEFAULT '[]'::jsonb,
      last_bounty  JSONB       NOT NULL DEFAULT
        '{"name":"Log analysis — production incident trace","value":180,"time":0}'::jsonb,
      tick_count   INTEGER     NOT NULL DEFAULT 0,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO lila_state (id) VALUES (1) ON CONFLICT DO NOTHING;

    CREATE TABLE IF NOT EXISTS lila_log (
      id         SERIAL      PRIMARY KEY,
      message    TEXT        NOT NULL,
      type       VARCHAR(10) NOT NULL DEFAULT 'info',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS lila_skills (
      id          SERIAL      PRIMARY KEY,
      name        TEXT        NOT NULL UNIQUE,
      description TEXT        NOT NULL,
      trigger     TEXT        NOT NULL,
      code        TEXT        NOT NULL,
      use_count   INTEGER     NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)
  schemaReady = true
}
