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
    -- Wipe legacy seed value — only touches the exact fake amount, never real earnings
    UPDATE lila_state SET total_earned = 0 WHERE id = 1 AND total_earned::numeric = 1247.50::numeric;
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

    CREATE TABLE IF NOT EXISTS chat_messages (
      id         SERIAL      PRIMARY KEY,
      sender     TEXT        NOT NULL,
      content    TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS analyst_notes (
      id         SERIAL      PRIMARY KEY,
      path       TEXT        NOT NULL UNIQUE,
      content    TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS analyst_state (
      id           INTEGER     PRIMARY KEY DEFAULT 1,
      step         TEXT        NOT NULL DEFAULT 'T0',
      cycle        INTEGER     NOT NULL DEFAULT 0,
      notes_buffer TEXT,
      last_step_at TIMESTAMPTZ,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO analyst_state (id) VALUES (1) ON CONFLICT DO NOTHING;

    CREATE TABLE IF NOT EXISTS lila_loop_state (
      id           INTEGER     PRIMARY KEY DEFAULT 1,
      step         TEXT        NOT NULL DEFAULT 'BT0',
      turn_count   INTEGER     NOT NULL DEFAULT 0,
      last_step_at TIMESTAMPTZ,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO lila_loop_state (id) VALUES (1) ON CONFLICT DO NOTHING;

    CREATE TABLE IF NOT EXISTS management_state (
      id             INTEGER       PRIMARY KEY DEFAULT 1,
      last_check_at  TIMESTAMPTZ,
      last_trade_at  TIMESTAMPTZ,
      last_earned    NUMERIC(12,2) NOT NULL DEFAULT 0,
      last_error_cnt INTEGER       NOT NULL DEFAULT 0,
      updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
    INSERT INTO management_state (id) VALUES (1) ON CONFLICT DO NOTHING;
    ALTER TABLE management_state ADD COLUMN IF NOT EXISTS last_trade_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS security_reports (
      id             SERIAL        PRIMARY KEY,
      bounty_id      TEXT          NOT NULL UNIQUE,
      platform       TEXT          NOT NULL,
      platform_label TEXT          NOT NULL,
      title          TEXT          NOT NULL,
      reward         NUMERIC(12,2) NOT NULL DEFAULT 0,
      chain          TEXT,
      url            TEXT,
      content        TEXT          NOT NULL,
      confidence     NUMERIC(3,2)  NOT NULL DEFAULT 0,
      status         TEXT          NOT NULL DEFAULT 'pending_review',
      review_notes   TEXT,
      created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
    ALTER TABLE security_reports ADD COLUMN IF NOT EXISTS review_notes TEXT;
    UPDATE security_reports SET status='pending_review' WHERE status='draft';

    -- Research targets: Tasker pins one bounty codebase and burns cycles on it.
    CREATE TABLE IF NOT EXISTS research_targets (
      id               SERIAL        PRIMARY KEY,
      bounty_id        TEXT          NOT NULL UNIQUE,
      platform         TEXT          NOT NULL,
      platform_label   TEXT          NOT NULL,
      title            TEXT          NOT NULL,
      reward           NUMERIC(12,2) NOT NULL DEFAULT 0,
      chain            TEXT,
      url              TEXT,
      scope            TEXT          NOT NULL,
      phase            TEXT          NOT NULL DEFAULT 'map',
      cycles           INTEGER       NOT NULL DEFAULT 0,
      fruitless_cycles INTEGER       NOT NULL DEFAULT 0,
      status           TEXT          NOT NULL DEFAULT 'active',
      first_worked_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      last_worked_at   TIMESTAMPTZ,
      updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS research_notes (
      id         SERIAL      PRIMARY KEY,
      target_id  INTEGER     NOT NULL REFERENCES research_targets(id) ON DELETE CASCADE,
      kind       TEXT        NOT NULL,
      content    TEXT        NOT NULL,
      ref        TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_research_notes_target ON research_notes(target_id);
    CREATE INDEX IF NOT EXISTS idx_research_notes_kind ON research_notes(target_id, kind);

    ALTER TABLE lila_state ADD COLUMN IF NOT EXISTS current_target_id INTEGER;

    CREATE TABLE IF NOT EXISTS llm_usage (
      id                SERIAL        PRIMARY KEY,
      module            TEXT          NOT NULL,
      model             TEXT          NOT NULL,
      prompt_tokens     INTEGER       NOT NULL DEFAULT 0,
      completion_tokens INTEGER       NOT NULL DEFAULT 0,
      cost_usd          NUMERIC(10,6) NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_llm_usage_created_at ON llm_usage(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_module ON llm_usage(module, created_at DESC);
  `)
  schemaReady = true
}
