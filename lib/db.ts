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
    -- Bookkeeping: a tracking flag that the trading-P&L-leak fix has been
    -- applied. Older deploys credited Alpaca P&L into total_earned; this
    -- migration rebases total_earned to the only honest source of truth —
    -- the sum of confirmed bounty payouts (security_reports.payout where
    -- status='paid'). Runs once via the v2 flag; v1 left residue when a
    -- deploy had losing paper trades (the old credit-on-wins code only
    -- inflated total_earned by positive PnL but v1 subtracted net PnL).
    ALTER TABLE lila_state ADD COLUMN IF NOT EXISTS reconciled_paper_pnl    BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE lila_state ADD COLUMN IF NOT EXISTS reconciled_paper_pnl_v2 BOOLEAN NOT NULL DEFAULT FALSE;
    DO $reconcile_v2$
    DECLARE
      paid_total NUMERIC;
    BEGIN
      IF NOT (SELECT reconciled_paper_pnl_v2 FROM lila_state WHERE id = 1) THEN
        SELECT COALESCE(SUM(payout), 0) INTO paid_total
          FROM security_reports
          WHERE status = 'paid' AND payout IS NOT NULL;
        UPDATE lila_state
          SET total_earned             = paid_total,
              reconciled_paper_pnl     = TRUE,
              reconciled_paper_pnl_v2  = TRUE
          WHERE id = 1;
      END IF;
    END
    $reconcile_v2$;

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

    -- ── Scout: volume bounty hunter ─────────────────────────────────────
    -- Sibling to Cipher but optimized for $1-5k payouts via shallow-but-
    -- fast triage of fresh targets — recently-listed protocols, forks of
    -- majors, post-seed-round scrappy projects. Higher miss rate is fine;
    -- the goal is 5-10 submissions per week. Output reports go to the
    -- same security_reports queue Cipher uses, tagged source='scout' so
    -- Lila reviews them at speed. Inputs come from watch_targets so
    -- Discovery and Scout share the funnel.
    ALTER TABLE security_reports ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'cipher';

    CREATE TABLE IF NOT EXISTS scout_state (
      id              INTEGER     PRIMARY KEY DEFAULT 1,
      step            TEXT        NOT NULL DEFAULT 'S0',
      cycle           INTEGER     NOT NULL DEFAULT 0,
      last_step_at    TIMESTAMPTZ,
      last_pick_at    TIMESTAMPTZ,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO scout_state (id) VALUES (1) ON CONFLICT DO NOTHING;
    ALTER TABLE scout_state ADD COLUMN IF NOT EXISTS last_pick_at TIMESTAMPTZ;

    -- Per-target scan ledger so we don't re-scan the same target every
    -- cycle. status: 'queued' | 'scanned' | 'reported' | 'dismissed'.
    CREATE TABLE IF NOT EXISTS scout_findings (
      id              SERIAL      PRIMARY KEY,
      target_id       INTEGER     REFERENCES watch_targets(id) ON DELETE SET NULL,
      target_name     TEXT,
      target_url      TEXT,
      severity        TEXT,
      summary         TEXT,
      details         TEXT,
      report_id       INTEGER     REFERENCES security_reports(id) ON DELETE SET NULL,
      status          TEXT        NOT NULL DEFAULT 'queued',
      scanned_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_scout_findings_target ON scout_findings(target_id);
    CREATE INDEX IF NOT EXISTS idx_scout_findings_status ON scout_findings(status, created_at DESC);

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
    -- Per-author article streams. Lila / Vega / Ceelo each write a noon
    -- report daily; existing Lila research deep-dives (default 'lila' /
    -- 'research-deepdive') still work via the same table.
    ALTER TABLE articles ADD COLUMN IF NOT EXISTS author TEXT NOT NULL DEFAULT 'lila';
    ALTER TABLE articles ADD COLUMN IF NOT EXISTS kind   TEXT NOT NULL DEFAULT 'research-deepdive';
    CREATE INDEX IF NOT EXISTS idx_articles_author_kind ON articles(author, kind, created_at DESC);

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

    -- Backtest results — per-sport historical accuracy. One row per
    -- (sport, ran_at). UI reads the most-recent row. ATS columns only
    -- populate for sports with closing_spread data (NFL via nflverse);
    -- margin_mae populates for all three (model spread vs actual margin).
    CREATE TABLE IF NOT EXISTS ceelo_backtest (
      id              SERIAL      PRIMARY KEY,
      sport           TEXT        NOT NULL,
      ran_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      total_games     INTEGER     NOT NULL DEFAULT 0,
      ats_wins        INTEGER,
      ats_losses      INTEGER,
      ats_pushes      INTEGER,
      ats_accuracy    NUMERIC(5,2),
      edge_wins       INTEGER,           -- subset where |model - close| ≥ threshold
      edge_losses     INTEGER,
      edge_accuracy   NUMERIC(5,2),
      edge_threshold  NUMERIC(5,2),
      margin_mae      NUMERIC(5,2),      -- mean abs error on predicted home-margin
      season_range    TEXT,
      notes           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ceelo_backtest_sport_ran ON ceelo_backtest(sport, ran_at DESC);

    -- Telegram alert dedup — stamped when a row's first
    -- alert-eligible state change has been pushed to the operator's
    -- chat. NULL = never alerted. Schema additions only; alert worker
    -- decides which transitions deserve a ping.
    ALTER TABLE security_reports ADD COLUMN IF NOT EXISTS tg_alerted_at TIMESTAMPTZ;
    ALTER TABLE ceelo_picks      ADD COLUMN IF NOT EXISTS tg_alerted_at TIMESTAMPTZ;
    ALTER TABLE lila_positions   ADD COLUMN IF NOT EXISTS tg_alerted_at TIMESTAMPTZ;

    -- Per-team-per-season EPA aggregates from nflverse play-by-play.
    -- Raw plays are not stored (too heavy — ~50k plays × 370 cols/season).
    -- We fetch the season pbp CSV in /api/ceelo/seed, aggregate to these
    -- columns in memory, then upsert here. This is the gold-standard
    -- handicapping signal — what 538 / sharp shops use.
    CREATE TABLE IF NOT EXISTS ceelo_team_epa (
      team               TEXT        NOT NULL,
      season             INTEGER     NOT NULL,
      -- Offense (team has the ball)
      epa_per_play       NUMERIC(7,4),     -- avg EPA / play (pass + run only)
      pass_epa           NUMERIC(7,4),
      rush_epa           NUMERIC(7,4),
      success_rate       NUMERIC(5,4),
      plays_offense      INTEGER,
      -- Defense (team is on D)
      epa_allowed        NUMERIC(7,4),
      pass_epa_allowed   NUMERIC(7,4),
      rush_epa_allowed   NUMERIC(7,4),
      success_allowed    NUMERIC(5,4),
      plays_defense      INTEGER,
      -- Net = offense_epa - defense_epa_allowed (higher = better team)
      net_epa            NUMERIC(7,4),
      computed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (team, season)
    );
    CREATE INDEX IF NOT EXISTS idx_ceelo_team_epa_season ON ceelo_team_epa(season, net_epa DESC);
    ALTER TABLE ceelo_state ADD COLUMN IF NOT EXISTS last_epa_at TIMESTAMPTZ;

    -- Depth charts (NFL only for now — nflverse weekly depth_charts file).
    -- Starter + immediate-backup per (team, position, formation). Refreshed
    -- weekly via Ceelo's loop. NBA / MLB depth ranking sources aren't
    -- ingested yet (basketball-reference / retrosheet are scrape-required).
    CREATE TABLE IF NOT EXISTS ceelo_depth_charts (
      id              SERIAL      PRIMARY KEY,
      sport           TEXT        NOT NULL DEFAULT 'NFL',
      season          INTEGER     NOT NULL,
      week            INTEGER     NOT NULL,
      team            TEXT        NOT NULL,
      player          TEXT        NOT NULL,
      position        TEXT        NOT NULL,
      depth_position  INTEGER     NOT NULL,        -- 1 = starter, 2 = backup
      formation       TEXT        NOT NULL,        -- 'Offense' | 'Defense' | 'Special Teams'
      fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (sport, team, position, formation, depth_position)
    );
    CREATE INDEX IF NOT EXISTS idx_ceelo_depth_team ON ceelo_depth_charts(sport, team, position);
    ALTER TABLE ceelo_state ADD COLUMN IF NOT EXISTS last_depth_at TIMESTAMPTZ;

    -- Current-season rosters. Refreshed weekly via ESPN's per-team endpoint.
    -- One row per (team, player). Stale players get pruned when a fresh
    -- fetch overwrites the team list.
    CREATE TABLE IF NOT EXISTS ceelo_rosters (
      id           SERIAL      PRIMARY KEY,
      team         TEXT        NOT NULL,
      player       TEXT        NOT NULL,
      position     TEXT,
      jersey       TEXT,
      height       TEXT,
      weight       TEXT,
      experience   INTEGER,
      college      TEXT,
      fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (team, player)
    );
    CREATE INDEX IF NOT EXISTS idx_ceelo_rosters_team ON ceelo_rosters(team, position);
    ALTER TABLE ceelo_state ADD COLUMN IF NOT EXISTS last_roster_at TIMESTAMPTZ;

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

    -- ── Multi-sport migration ─────────────────────────────────────────────
    -- Default everything existing to 'NFL' (only sport before this change).
    -- ceelo_team_ratings.team was the PK; with NBA + MLB, abbrs collide
    -- (LAC = Chargers AND Clippers) so PK becomes (sport, team).
    ALTER TABLE ceelo_games        ADD COLUMN IF NOT EXISTS sport TEXT NOT NULL DEFAULT 'NFL';
    ALTER TABLE ceelo_team_ratings ADD COLUMN IF NOT EXISTS sport TEXT NOT NULL DEFAULT 'NFL';
    ALTER TABLE ceelo_model_lines  ADD COLUMN IF NOT EXISTS sport TEXT NOT NULL DEFAULT 'NFL';
    ALTER TABLE ceelo_lines        ADD COLUMN IF NOT EXISTS sport TEXT NOT NULL DEFAULT 'NFL';

    -- Public betting % from a future scrape source (covers / sbr). Stored
    -- per-line so each fetch can update; null until the scraper lands.
    ALTER TABLE ceelo_lines        ADD COLUMN IF NOT EXISTS public_bets_pct  NUMERIC(5,2);
    ALTER TABLE ceelo_lines        ADD COLUMN IF NOT EXISTS public_money_pct NUMERIC(5,2);
    ALTER TABLE ceelo_lines        ADD COLUMN IF NOT EXISTS public_side      TEXT;        -- 'home' | 'away'
    ALTER TABLE ceelo_lines        ADD COLUMN IF NOT EXISTS open_home_line   NUMERIC(6,2);

    -- Rebuild the team-ratings PK as composite (sport, team).
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ceelo_team_ratings_pkey'
          AND conrelid = 'ceelo_team_ratings'::regclass
      ) THEN
        ALTER TABLE ceelo_team_ratings DROP CONSTRAINT ceelo_team_ratings_pkey;
        ALTER TABLE ceelo_team_ratings ADD PRIMARY KEY (sport, team);
      END IF;
    EXCEPTION WHEN others THEN NULL;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_ceelo_games_sport_kickoff
      ON ceelo_games(sport, kickoff_at);

    -- Migrations: link picks to games + carry the math behind each pick.
    ALTER TABLE ceelo_picks ADD COLUMN IF NOT EXISTS game_id        INTEGER REFERENCES ceelo_games(id) ON DELETE SET NULL;
    ALTER TABLE ceelo_picks ADD COLUMN IF NOT EXISTS model_spread   NUMERIC(5,2);
    ALTER TABLE ceelo_picks ADD COLUMN IF NOT EXISTS book_spread    NUMERIC(5,2);
    ALTER TABLE ceelo_picks ADD COLUMN IF NOT EXISTS book_name      TEXT;
    ALTER TABLE ceelo_picks ADD COLUMN IF NOT EXISTS edge_points    NUMERIC(5,2);
    ALTER TABLE ceelo_picks ADD COLUMN IF NOT EXISTS source         TEXT NOT NULL DEFAULT 'llm';
    -- Auto-graded model accuracy. Separate from operator's W/L tracking
    -- (status='won'|'lost' = operator-marked). model_outcome is the
    -- model's hypothetical performance — graded after the game finishes
    -- regardless of whether the operator took the pick. Lets the
    -- operator measure Ceelo per-sport without requiring real bets.
    --   'win'  — pick covered
    --   'loss' — pick didn't cover
    --   'push' — actual margin matched the spread exactly
    --   NULL   — game not yet final OR pick not from a model source
    ALTER TABLE ceelo_picks ADD COLUMN IF NOT EXISTS model_outcome  TEXT;
    ALTER TABLE ceelo_picks ADD COLUMN IF NOT EXISTS model_graded_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_ceelo_picks_sport_model_outcome
      ON ceelo_picks(sport, model_outcome) WHERE source='model';
                                                  -- 'llm' (v1) | 'model' (v2 math-driven)
  `)
  schemaReady = true
}
