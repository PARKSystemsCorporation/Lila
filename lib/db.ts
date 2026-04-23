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
      id              INTEGER       PRIMARY KEY DEFAULT 1,
      total_earned    NUMERIC(12,2) NOT NULL DEFAULT 0,
      active_tasks    JSONB         NOT NULL DEFAULT '[]'::jsonb,
      last_bounty     JSONB         NOT NULL DEFAULT '{"name":"None yet","value":0,"time":0}'::jsonb,
      tick_count      INTEGER       NOT NULL DEFAULT 0,
      assigned_bounty JSONB         DEFAULT NULL,
      updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
    INSERT INTO lila_state (id) VALUES (1) ON CONFLICT DO NOTHING;
    -- Reset legacy seed data
    UPDATE lila_state SET total_earned = 0 WHERE id = 1 AND total_earned = 1247.50;
    -- Add assigned_bounty column if upgrading from earlier schema
    ALTER TABLE lila_state ADD COLUMN IF NOT EXISTS assigned_bounty JSONB DEFAULT NULL;

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

    CREATE TABLE IF NOT EXISTS analyst_picks (
      id          SERIAL        PRIMARY KEY,
      symbol      TEXT          NOT NULL,
      direction   TEXT          NOT NULL,
      entry_price NUMERIC(12,4),
      target_price NUMERIC(12,4),
      stop_loss   NUMERIC(12,4),
      confidence  NUMERIC(3,2),
      risk_level  TEXT,
      reason      TEXT,
      asset_class TEXT          NOT NULL DEFAULT 'stock',
      status      TEXT          NOT NULL DEFAULT 'pending',
      created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS lila_positions (
      id           SERIAL        PRIMARY KEY,
      symbol       TEXT          NOT NULL,
      direction    TEXT          NOT NULL,
      entry_price  NUMERIC(12,4),
      target_price NUMERIC(12,4),
      stop_loss    NUMERIC(12,4),
      platform     TEXT          NOT NULL DEFAULT 'alpaca',
      pick_id      INTEGER,
      status       TEXT          NOT NULL DEFAULT 'open',
      pnl          NUMERIC(12,2),
      opened_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      closed_at    TIMESTAMPTZ
    );
  `)
  schemaReady = true
}
