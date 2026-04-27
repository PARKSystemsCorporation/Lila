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
      bounty_turn       INTEGER       NOT NULL DEFAULT 0,
      updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
    INSERT INTO lila_state (id) VALUES (1) ON CONFLICT DO NOTHING;
    ALTER TABLE lila_state ADD COLUMN IF NOT EXISTS assigned_bounty   JSONB   DEFAULT NULL;
    ALTER TABLE lila_state ADD COLUMN IF NOT EXISTS current_target_id INTEGER;
    ALTER TABLE lila_state ADD COLUMN IF NOT EXISTS bounty_turn       INTEGER NOT NULL DEFAULT 0;
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
      thread     TEXT        NOT NULL DEFAULT 'main',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Migration: thread column was added after the table first shipped.
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS thread       TEXT NOT NULL DEFAULT 'main';
    -- Telegram bridge: 'via' tags where a message came from
    -- ('telegram' | 'web' | NULL). 'mirrored_at' marks Lila replies that
    -- have been pushed back to Telegram so we don't double-send.
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS via          TEXT;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS mirrored_at  TIMESTAMPTZ;
    -- 'kind' separates true conversational messages from agent status posts
    -- and system alerts. The Chat tab only renders kind='message' so the
    -- conversation isn't drowned in cycle-completion / earnings rollups.
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kind         TEXT NOT NULL DEFAULT 'message';
    -- Backfill: tag obvious agent status posts and broadcast alerts in
    -- existing rows so the Chat tab cleans up immediately on deploy.
    UPDATE chat_messages SET kind = 'alert'
      WHERE kind = 'message' AND content LIKE '⚠%';
    UPDATE chat_messages SET kind = 'status'
      WHERE kind = 'message' AND (
            content LIKE 'Cycle %complete%'
         OR content LIKE 'Maintenance P&L:%'
         OR content LIKE '%queued for Lila%'
         OR content LIKE '%task%active.%'
         OR content LIKE 'Earned $%'
         OR content ~ '^[A-Z]{1,3}\d ?[A-Z]?:'
      );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_kind ON chat_messages(thread, kind, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_mirror ON chat_messages(thread, sender, mirrored_at)
      WHERE sender='lila' AND mirrored_at IS NULL;

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

    -- Research targets: Cipher pins one bounty codebase and burns cycles on it.
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
      id                   SERIAL      PRIMARY KEY,
      channel              TEXT        NOT NULL,
      content              TEXT        NOT NULL,
      status               TEXT        NOT NULL,
      external_id          TEXT,
      error                TEXT,
      scheduled_publish_at TIMESTAMPTZ,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS scheduled_publish_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_broadcasts_created ON broadcasts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_broadcasts_pending ON broadcasts(status, scheduled_publish_at) WHERE status = 'pending_publish';

    CREATE TABLE IF NOT EXISTS broadcast_state (
      id                INTEGER     PRIMARY KEY DEFAULT 1,
      last_broadcast_at TIMESTAMPTZ,
      last_signal_key   TEXT,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO broadcast_state (id) VALUES (1) ON CONFLICT DO NOTHING;

    -- Watchlist: protocols we've spotted via DefiLlama / GitHub / etc that
    -- Cipher might want to research later. Separate from research_targets
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

    -- Articles: technical deep-dives Lila drafts from completed research.
    -- Operator publishes manually (Substack / mirror.xyz / personal site)
    -- and pastes the URL back via the Articles card.
    CREATE TABLE IF NOT EXISTS articles (
      id           SERIAL      PRIMARY KEY,
      title        TEXT        NOT NULL,
      content      TEXT        NOT NULL,
      source       TEXT,
      status       TEXT        NOT NULL DEFAULT 'draft',
      external_url TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status, created_at DESC);

    -- Ceelo: NFL handicapper. Posts picks; operator decides which to take and
    -- marks W/L. Strictly informational — no auto-execution. Bankroll lives
    -- entirely in operator-entered stake/payout amounts on each pick.
    CREATE TABLE IF NOT EXISTS ceelo_picks (
      id              SERIAL        PRIMARY KEY,
      sport           TEXT          NOT NULL DEFAULT 'NFL',
      game_label      TEXT          NOT NULL,           -- e.g. "KC @ BUF"
      kickoff_at      TIMESTAMPTZ,                       -- best-effort
      market          TEXT          NOT NULL,            -- 'spread' | 'moneyline' | 'total'
      side            TEXT          NOT NULL,            -- e.g. "KC -3", "Over 47.5", "BUF ML"
      model_prob      NUMERIC(4,3),                      -- Ceelo's modeled probability
      fair_line       TEXT,                              -- Ceelo's fair-line estimate (string for flexibility)
      min_odds        INTEGER,                           -- min American odds Ceelo wants
      edge_pct        NUMERIC(5,2),                      -- edge vs implied @ min_odds (computed)
      reasoning       TEXT          NOT NULL,            -- one-paragraph thesis
      confidence      TEXT          NOT NULL DEFAULT 'medium',  -- low | medium | high
      status          TEXT          NOT NULL DEFAULT 'open',
                                    -- open | skipped | taken | won | lost | push | void
      stake           NUMERIC(10,2),                     -- operator-entered when taken
      taken_odds      INTEGER,                           -- American odds operator actually got
      payout          NUMERIC(10,2),                     -- net P&L (stake-relative); push/void = 0
      taken_at        TIMESTAMPTZ,
      settled_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ceelo_picks_status ON ceelo_picks(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ceelo_picks_kickoff ON ceelo_picks(kickoff_at);

    CREATE TABLE IF NOT EXISTS ceelo_state (
      id            INTEGER     PRIMARY KEY DEFAULT 1,
      cycle         INTEGER     NOT NULL DEFAULT 0,
      last_run_at   TIMESTAMPTZ,
      last_schedule_at TIMESTAMPTZ,
      last_grade_at    TIMESTAMPTZ,
      last_lines_at    TIMESTAMPTZ,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO ceelo_state (id) VALUES (1) ON CONFLICT DO NOTHING;
    -- Migrations for fields added after the table first shipped.
    ALTER TABLE ceelo_state ADD COLUMN IF NOT EXISTS last_schedule_at  TIMESTAMPTZ;
    ALTER TABLE ceelo_state ADD COLUMN IF NOT EXISTS last_grade_at     TIMESTAMPTZ;
    ALTER TABLE ceelo_state ADD COLUMN IF NOT EXISTS last_lines_at     TIMESTAMPTZ;
    ALTER TABLE ceelo_state ADD COLUMN IF NOT EXISTS last_injury_at    TIMESTAMPTZ;
    ALTER TABLE ceelo_state ADD COLUMN IF NOT EXISTS last_seed_at      TIMESTAMPTZ;

    -- Closing lines per game from nflverse historical data. Surface for
    -- backtesting and to seed Ceelo's awareness of where the market closed.
    ALTER TABLE ceelo_games ADD COLUMN IF NOT EXISTS closing_spread    NUMERIC(5,2);
    ALTER TABLE ceelo_games ADD COLUMN IF NOT EXISTS closing_total     NUMERIC(5,2);

    -- Backfill ledger — which seasons have been Elo-walked.
    CREATE TABLE IF NOT EXISTS ceelo_backfill (
      season       INTEGER     PRIMARY KEY,
      games_in     INTEGER     NOT NULL DEFAULT 0,
      graded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Injury report snapshot. Refreshed daily via ESPN's per-team endpoint.
    -- We dedupe on (team, player) and keep the latest status; a fresh fetch
    -- replaces older rows for that team.
    CREATE TABLE IF NOT EXISTS ceelo_injuries (
      id           SERIAL      PRIMARY KEY,
      team         TEXT        NOT NULL,
      player       TEXT        NOT NULL,
      position     TEXT,
      status       TEXT,                         -- 'Out' | 'Questionable' | 'Doubtful' | 'IR' | 'PUP' | 'Active'
      description  TEXT,
      fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (team, player)
    );
    CREATE INDEX IF NOT EXISTS idx_ceelo_injuries_team ON ceelo_injuries(team, status);

    -- Schedule: one row per known NFL game. ESPN's event id is the natural key.
    CREATE TABLE IF NOT EXISTS ceelo_games (
      id           SERIAL      PRIMARY KEY,
      espn_id      TEXT        UNIQUE,
      season       INTEGER     NOT NULL,
      week         INTEGER,
      season_type  INTEGER,                -- 1=preseason, 2=regular, 3=postseason
      home_team    TEXT        NOT NULL,
      away_team    TEXT        NOT NULL,
      kickoff_at   TIMESTAMPTZ,
      status       TEXT        NOT NULL DEFAULT 'scheduled',
                                            -- scheduled | in_progress | final | postponed
      home_score   INTEGER,
      away_score   INTEGER,
      neutral_site BOOLEAN     NOT NULL DEFAULT FALSE,
      graded_at    TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ceelo_games_kickoff ON ceelo_games(kickoff_at);
    CREATE INDEX IF NOT EXISTS idx_ceelo_games_status ON ceelo_games(status, kickoff_at);

    -- Power ratings — one row per team, updated after every graded game.
    CREATE TABLE IF NOT EXISTS ceelo_team_ratings (
      team           TEXT        PRIMARY KEY,           -- 2-3 letter abbr (KC, BUF, etc.)
      rating         NUMERIC(8,3) NOT NULL DEFAULT 1500,
      games_played   INTEGER     NOT NULL DEFAULT 0,
      last_game_at   TIMESTAMPTZ,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Model line per upcoming game. Recomputed on every cycle (cheap).
    CREATE TABLE IF NOT EXISTS ceelo_model_lines (
      game_id          INTEGER     PRIMARY KEY REFERENCES ceelo_games(id) ON DELETE CASCADE,
      model_spread     NUMERIC(5,2),         -- home spread (negative = home favored)
      model_home_prob  NUMERIC(4,3),
      computed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Book lines history — populated only when ODDS_API_KEY is set.
    CREATE TABLE IF NOT EXISTS ceelo_lines (
      id           SERIAL      PRIMARY KEY,
      game_id      INTEGER     NOT NULL REFERENCES ceelo_games(id) ON DELETE CASCADE,
      book         TEXT        NOT NULL,             -- 'draftkings' | 'fanduel' | etc.
      market       TEXT        NOT NULL,             -- 'spread' | 'total' | 'moneyline'
      home_line    NUMERIC(6,2),
      total_line   NUMERIC(6,2),
      home_odds    INTEGER,
      away_odds    INTEGER,
      over_odds    INTEGER,
      under_odds   INTEGER,
      fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ceelo_lines_game ON ceelo_lines(game_id, market, fetched_at DESC);

    -- Migrations: link picks to games + carry the math behind each pick.
    ALTER TABLE ceelo_picks ADD COLUMN IF NOT EXISTS game_id        INTEGER REFERENCES ceelo_games(id) ON DELETE SET NULL;
    ALTER TABLE ceelo_picks ADD COLUMN IF NOT EXISTS model_spread   NUMERIC(5,2);
    ALTER TABLE ceelo_picks ADD COLUMN IF NOT EXISTS book_spread    NUMERIC(5,2);
    ALTER TABLE ceelo_picks ADD COLUMN IF NOT EXISTS book_name      TEXT;
    ALTER TABLE ceelo_picks ADD COLUMN IF NOT EXISTS edge_points    NUMERIC(5,2);
    ALTER TABLE ceelo_picks ADD COLUMN IF NOT EXISTS source         TEXT NOT NULL DEFAULT 'llm';
                                                  -- 'llm' (v1) | 'model' (v2 math-driven)
  `)
  schemaReady = true
}
