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

// Creates every table the app needs, idempotently. Includes the ALTERs we
// still need for safe upgrades from older deployments (last_bounty drop,
// security_reports payout columns, etc.).
export async function ensureSchema(client: PoolClient): Promise<void> {
  if (schemaReady) return
  await client.query(`
    CREATE TABLE IF NOT EXISTS lila_state (
      id                INTEGER       PRIMARY KEY DEFAULT 1,
      total_earned      NUMERIC(12,2) NOT NULL DEFAULT 0,
      active_tasks      JSONB         NOT NULL DEFAULT '[]'::jsonb,
      tick_count        INTEGER       NOT NULL DEFAULT 0,
      assigned_bounty   JSONB         DEFAULT NULL,
      current_target_id INTEGER,
      updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
    INSERT INTO lila_state (id) VALUES (1) ON CONFLICT DO NOTHING;
    ALTER TABLE lila_state ADD COLUMN IF NOT EXISTS assigned_bounty JSONB DEFAULT NULL;
    ALTER TABLE lila_state ADD COLUMN IF NOT EXISTS current_target_id INTEGER;
    ALTER TABLE lila_state DROP COLUMN IF EXISTS last_bounty;

    CREATE TABLE IF NOT EXISTS lila_log (
      id         SERIAL      PRIMARY KEY,
      message    TEXT        NOT NULL,
      type       VARCHAR(10) NOT NULL DEFAULT 'info',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS analyst_picks (
      id           SERIAL        PRIMARY KEY,
      symbol       TEXT          NOT NULL,
      direction    TEXT          NOT NULL,
      entry_price  NUMERIC(12,4),
      target_price NUMERIC(12,4),
      stop_loss    NUMERIC(12,4),
      confidence   NUMERIC(3,2),
      risk_level   TEXT,
      reason       TEXT,
      asset_class  TEXT          NOT NULL DEFAULT 'stock',
      status       TEXT          NOT NULL DEFAULT 'pending',
      created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
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
      id                INTEGER       PRIMARY KEY DEFAULT 1,
      last_check_at     TIMESTAMPTZ,
      last_trade_at     TIMESTAMPTZ,
      last_retention_at TIMESTAMPTZ,
      last_earned       NUMERIC(12,2) NOT NULL DEFAULT 0,
      last_error_cnt    INTEGER       NOT NULL DEFAULT 0,
      updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
    INSERT INTO management_state (id) VALUES (1) ON CONFLICT DO NOTHING;
    ALTER TABLE management_state ADD COLUMN IF NOT EXISTS last_trade_at     TIMESTAMPTZ;
    ALTER TABLE management_state ADD COLUMN IF NOT EXISTS last_retention_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS security_reports (
      id             SERIAL        PRIMARY KEY,
      bounty_id      TEXT          NOT NULL UNIQUE,
      platform       TEXT          NOT NULL,
      platform_label TEXT          NOT NULL,
      title          TEXT          NOT NULL,
      reward         NUMERIC(12,2) NOT NULL DEFAULT 0,   -- max bounty per platform brief
      chain          TEXT,
      url            TEXT,
      content        TEXT          NOT NULL,
      confidence     NUMERIC(3,2)  NOT NULL DEFAULT 0,
      status         TEXT          NOT NULL DEFAULT 'pending_review',
      kind           TEXT          NOT NULL DEFAULT 'security',  -- 'security' | 'code'
      review_notes   TEXT,
      payout         NUMERIC(12,2),                        -- actual $ received (NULL until paid)
      submitted_at   TIMESTAMPTZ,
      paid_at        TIMESTAMPTZ,
      created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
    ALTER TABLE security_reports ADD COLUMN IF NOT EXISTS review_notes TEXT;
    ALTER TABLE security_reports ADD COLUMN IF NOT EXISTS kind         TEXT NOT NULL DEFAULT 'security';
    ALTER TABLE security_reports ADD COLUMN IF NOT EXISTS payout       NUMERIC(12,2);
    ALTER TABLE security_reports ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
    ALTER TABLE security_reports ADD COLUMN IF NOT EXISTS paid_at      TIMESTAMPTZ;
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
    CREATE INDEX IF NOT EXISTS idx_research_notes_kind   ON research_notes(target_id, kind);

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
    CREATE INDEX IF NOT EXISTS idx_llm_usage_module     ON llm_usage(module, created_at DESC);

    CREATE TABLE IF NOT EXISTS broadcasts (
      id          SERIAL      PRIMARY KEY,
      channel     TEXT        NOT NULL,
      content     TEXT        NOT NULL,
      status      TEXT        NOT NULL,
      external_id TEXT,
      error       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_broadcasts_created ON broadcasts(created_at DESC);

    CREATE TABLE IF NOT EXISTS broadcast_state (
      id                INTEGER     PRIMARY KEY DEFAULT 1,
      last_broadcast_at TIMESTAMPTZ,
      last_signal_key   TEXT,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO broadcast_state (id) VALUES (1) ON CONFLICT DO NOTHING;

    -- Watchlist: protocols we've spotted via DefiLlama / GitHub / etc that
    -- Tasker might want to research later. Separate from research_targets
    -- (active work) — this is the speculative pipeline.
    CREATE TABLE IF NOT EXISTS watch_targets (
      id             SERIAL        PRIMARY KEY,
      source         TEXT          NOT NULL,            -- 'defillama' | 'github' | ...
      external_id    TEXT          NOT NULL,            -- source-specific id/slug/repo
      name           TEXT          NOT NULL,
      url            TEXT,
      chain          TEXT,
      tvl            NUMERIC(16,2),                     -- defillama
      stars          INTEGER,                           -- github
      listed_at      TIMESTAMPTZ,                       -- source-reported creation/listing
      scope          TEXT,                              -- short blurb for later triage
      status         TEXT          NOT NULL DEFAULT 'watching',  -- watching|promoted|dismissed
      first_seen_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      UNIQUE (source, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_watch_targets_status ON watch_targets(status, first_seen_at DESC);

    CREATE TABLE IF NOT EXISTS discovery_state (
      id          INTEGER     PRIMARY KEY DEFAULT 1,
      last_run_at TIMESTAMPTZ,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO discovery_state (id) VALUES (1) ON CONFLICT DO NOTHING;

    -- Legacy tables removed: lila_skills (Hermes synth, unused).
    DROP TABLE IF EXISTS lila_skills;
  `)
  schemaReady = true
}
