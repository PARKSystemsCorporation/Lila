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
    -- One-shot retag for pre-2026-04-27 Lila auto-posts that the original
    -- kind backfill missed. Heuristic below uses 'no preceding user
    -- message in the prior 20 min' (same window replyToOperator uses) to
    -- distinguish unsolicited posts from replies.
    ALTER TABLE lila_state ADD COLUMN IF NOT EXISTS retag_legacy_lila_v1    BOOLEAN NOT NULL DEFAULT FALSE;
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
    -- Trade-cycle stance posts carry a free-form LLM read of the market
    -- followed by an optional "N new trades queued." / "Cut N positions."
    -- suffix. The kind-default-message migration didn't catch these
    -- because the prefix is unstructured. Suffix-match retag is idempotent
    -- (already-tagged rows excluded by kind='message').
    UPDATE chat_messages SET kind = 'status'
      WHERE kind = 'message' AND sender = 'lila'
        AND (
              content LIKE '% new trade queued.%'
           OR content LIKE '% new trades queued.%'
           OR content ~ 'Cut [0-9]+ position'
        );
    -- One-shot heuristic retag for pre-2026-04-27 Lila posts that the
    -- pattern-based backfill missed (free-form stance text with no
    -- queue/close suffix). A legitimate operator reply is preceded by a
    -- 'user' message in the prior 20 min (replyToOperator's own lookback);
    -- anything else from that era was an unsolicited auto-post. Gated by
    -- retag_legacy_lila_v1 so it only runs once per DB.
    DO $retag_legacy_lila_v1$
    BEGIN
      IF NOT (SELECT retag_legacy_lila_v1 FROM lila_state WHERE id = 1) THEN
        UPDATE chat_messages c SET kind = 'status'
          WHERE c.kind = 'message'
            AND c.sender = 'lila'
            AND c.thread = 'main'
            AND c.created_at < '2026-04-27'::timestamptz
            AND NOT EXISTS (
              SELECT 1 FROM chat_messages u
              WHERE u.sender = 'user'
                AND u.thread = 'main'
                AND u.created_at < c.created_at
                AND u.created_at > c.created_at - INTERVAL '20 minutes'
            );
        UPDATE lila_state SET retag_legacy_lila_v1 = TRUE WHERE id = 1;
      END IF;
    END
    $retag_legacy_lila_v1$;
    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_kind ON chat_messages(thread, kind, created_at DESC);

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
      last_retention_at TIMESTAMPTZ,
      updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
    INSERT INTO management_state (id) VALUES (1) ON CONFLICT DO NOTHING;
    ALTER TABLE management_state ADD COLUMN IF NOT EXISTS last_retention_at TIMESTAMPTZ;
    -- Drop legacy ManagementLoop columns. The class is gone; autonomy
    -- tree (lib/autonomy/) owns Lila's decisioning now and persists its
    -- own state via last_route_path / last_route_at below.
    ALTER TABLE management_state DROP COLUMN IF EXISTS last_check_at;
    ALTER TABLE management_state DROP COLUMN IF EXISTS last_trade_at;
    ALTER TABLE management_state DROP COLUMN IF EXISTS last_earned;
    ALTER TABLE management_state DROP COLUMN IF EXISTS last_error_cnt;
    ALTER TABLE management_state DROP COLUMN IF EXISTS last_proactive_event;
    ALTER TABLE management_state DROP COLUMN IF EXISTS last_proactive_at;

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
    -- Stamped on the agent's first chat introduction so the intro fires
    -- exactly once per deploy.
    ALTER TABLE scout_state ADD COLUMN IF NOT EXISTS introduced_at TIMESTAMPTZ;

    -- ── Forge: fast Algora-only PR drafter ──────────────────────────────
    -- Same time-gate ledger shape as scout_state. Forge writes into
    -- bounty_picks tagged created_by='forge' (see ALTER below).
    CREATE TABLE IF NOT EXISTS forge_state (
      id              INTEGER     PRIMARY KEY DEFAULT 1,
      cycle           INTEGER     NOT NULL DEFAULT 0,
      last_step_at    TIMESTAMPTZ,
      last_pick_at    TIMESTAMPTZ,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO forge_state (id) VALUES (1) ON CONFLICT DO NOTHING;
    ALTER TABLE forge_state ADD COLUMN IF NOT EXISTS introduced_at TIMESTAMPTZ;

    -- ── Artist: autonomous painter ──────────────────────────────────────
    -- One piece per cycle via fal.ai FLUX.1 schnell. Pieces persist as
    -- base64 in artist_gallery so we don't need a blob store; the loop
    -- trims to the most recent ~200 rows after each insert.
    CREATE TABLE IF NOT EXISTS artist_state (
      id              INTEGER     PRIMARY KEY DEFAULT 1,
      cycle           INTEGER     NOT NULL DEFAULT 0,
      last_step_at    TIMESTAMPTZ,
      introduced_at   TIMESTAMPTZ,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO artist_state (id) VALUES (1) ON CONFLICT DO NOTHING;

    CREATE TABLE IF NOT EXISTS artist_gallery (
      id          BIGSERIAL   PRIMARY KEY,
      prompt      TEXT        NOT NULL,
      image_b64   TEXT        NOT NULL,
      mime_type   TEXT        NOT NULL DEFAULT 'image/png',
      model       TEXT        NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_artist_gallery_created
      ON artist_gallery (created_at DESC);

    -- Per-(agent, chat_message) ack ledger so Forge / Scout each
    -- acknowledge an operator/Lila mention exactly once.
    CREATE TABLE IF NOT EXISTS agent_chat_acks (
      id              SERIAL PRIMARY KEY,
      agent           TEXT NOT NULL,
      chat_message_id INTEGER NOT NULL,
      acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent, chat_message_id)
    );

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

    -- Operator's desk — agents push docs here for review. Workflow:
    --   pending  → agent just filed it; operator hasn't acted
    --   approved → operator hit approve; Lila will read + report on next tick
    --   reported → Lila has read it and posted her report to chat
    --   denied   → operator rejected; comment captured so the agent's
    --              future drafts can avoid the dead-end direction
    --
    -- 'kind' is a free-form tag — 'doc' / 'memo' / 'pitch' / 'finding' /
    -- 'plan' / 'briefing'. Used only for the UI badge color.
    CREATE TABLE IF NOT EXISTS desk_items (
      id              SERIAL      PRIMARY KEY,
      from_agent      TEXT        NOT NULL,                 -- 'lila' | 'cipher' | 'vega' | 'scout' | 'ceelo'
      title           TEXT        NOT NULL,
      summary         TEXT,                                  -- one-liner for the list view
      body            TEXT        NOT NULL,                  -- markdown
      kind            TEXT        NOT NULL DEFAULT 'doc',
      status          TEXT        NOT NULL DEFAULT 'pending',
      operator_comment TEXT,
      approved_at     TIMESTAMPTZ,
      denied_at       TIMESTAMPTZ,
      reported_at     TIMESTAMPTZ,
      report_message  TEXT,                                  -- the chat reply Lila posted
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_desk_items_status    ON desk_items(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_desk_items_from      ON desk_items(from_agent, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_desk_items_approved  ON desk_items(status, reported_at)
      WHERE status='approved' AND reported_at IS NULL;

    -- Public-viewer subscribers — Gumroad license-key gated. Each row is
    -- a paying viewer; the cookie carries the key and an exp timestamp.
    -- The middleware verifies the HMAC sig + exp on every request; the
    -- /api/viewer/login route re-verifies the key against Gumroad's
    -- license API on first sign-in and after VIEWER_REVERIFY_HOURS.
    CREATE TABLE IF NOT EXISTS viewers (
      id                       SERIAL      PRIMARY KEY,
      license_key              TEXT        NOT NULL UNIQUE,
      gumroad_product_id       TEXT,
      gumroad_subscription_id  TEXT,
      verified_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      active                   BOOLEAN     NOT NULL DEFAULT TRUE,
      email                    TEXT,                              -- captured from Gumroad if returned
      created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_viewers_active ON viewers(active, verified_at DESC);

    -- Park Gates wallet — 50 free per calendar month for active viewers,
    -- granted lazily on /api/viewer/login. Spend paths debit park_gates
    -- and append a row to park_gates_ledger for audit.
    ALTER TABLE viewers ADD COLUMN IF NOT EXISTS park_gates           INTEGER     NOT NULL DEFAULT 0;
    ALTER TABLE viewers ADD COLUMN IF NOT EXISTS last_gate_grant_at   TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS park_gates_ledger (
      id          BIGSERIAL   PRIMARY KEY,
      viewer_id   INTEGER     NOT NULL REFERENCES viewers(id) ON DELETE CASCADE,
      delta       INTEGER     NOT NULL,
      reason      TEXT        NOT NULL,    -- 'monthly_grant' | 'spend' | 'admin_adjust'
      ref         TEXT,                    -- subscription_id, edge_id, etc.
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_park_gates_ledger_viewer
      ON park_gates_ledger(viewer_id, created_at DESC);

    -- Anonymous landing-page event log. Used for buy-pass click counts
    -- and any other public-facing conversion telemetry. No PII; the
    -- 'ref' column carries the source label (e.g. 'hero', 'pricing').
    CREATE TABLE IF NOT EXISTS landing_events (
      id          BIGSERIAL   PRIMARY KEY,
      event       TEXT        NOT NULL,
      ref         TEXT,
      ua_hash     TEXT,                        -- short hashed UA for rough dedupe
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_landing_events_event
      ON landing_events(event, created_at DESC);

    -- Marketplace direct-message queue. A viewer spends Park Gates to
    -- send one prompt to an agent (lila / ceelo / vega); the row carries
    -- the prompt + the eventual reply. Status flow:
    --   queued    → debited, awaiting agent reply
    --   answered  → reply written, viewer can read it
    --   refunded  → spend reversed (ledger row 'refund'); usually unused
    CREATE TABLE IF NOT EXISTS viewer_dms (
      id            BIGSERIAL   PRIMARY KEY,
      viewer_id     INTEGER     NOT NULL REFERENCES viewers(id) ON DELETE CASCADE,
      agent         TEXT        NOT NULL,    -- 'lila' | 'ceelo' | 'vega'
      prompt        TEXT        NOT NULL,
      reply         TEXT,
      cost_pg       INTEGER     NOT NULL DEFAULT 10,
      status        TEXT        NOT NULL DEFAULT 'queued',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      answered_at   TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_viewer_dms_viewer
      ON viewer_dms(viewer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_viewer_dms_pending
      ON viewer_dms(agent, created_at) WHERE status = 'queued';

    -- Scout's volume-bounty pipeline. Sourced from Gitcoin + Algora (and
    -- whichever sources we add later). Each row carries the FULL submission
    -- deliverable (markdown PR body + unified diff) so Lila can review +
    -- approve without operator involvement, and the GitHub PR worker (if
    -- LILA_AUTO_SUBMIT=true and GITHUB_TOKEN configured) can open the PR
    -- automatically.
    --
    -- Status flow:
    --   discovered    → pulled from source, not yet drafted
    --   drafted       → Scout produced a deliverable, awaiting Lila review
    --   approved      → Lila approved; ready to submit (if auto-submit off,
    --                   waits for operator; if on, PR worker takes it)
    --   submitted     → PR opened (auto or manual)
    --   paid          → bounty paid out (operator marks; eventually source-
    --                   side webhook in a future iteration)
    --   rejected      → Lila or operator rejected; soft-delete
    CREATE TABLE IF NOT EXISTS bounty_picks (
      id              SERIAL      PRIMARY KEY,
      source          TEXT        NOT NULL,                  -- 'gitcoin' | 'algora'
      external_id     TEXT        NOT NULL,                  -- source-specific id; uniqueness is per-source
      url             TEXT        NOT NULL,
      title           TEXT        NOT NULL,
      summary         TEXT,
      payout_usd      NUMERIC(12,2),                          -- listed reward in USD (best-effort)
      payout_token    TEXT,                                   -- 'USDC' / 'ETH' / etc when crypto
      payout_token_amount NUMERIC(20,6),                      -- raw token amount
      repo_url        TEXT,                                   -- GitHub repo (if available)
      issue_number    INTEGER,                                -- GitHub issue # (if linked)
      issue_body      TEXT,                                   -- full issue text snapshot for drafting
      language        TEXT,                                   -- primary language hint
      labels          TEXT[],                                 -- source-side labels
      difficulty      TEXT,                                   -- 'beginner' | 'intermediate' | 'advanced' | NULL
      status          TEXT        NOT NULL DEFAULT 'discovered',
      -- Drafted deliverable (Scout's S2 output)
      draft_title     TEXT,
      draft_body      TEXT,                                   -- full PR description in markdown
      draft_diff      TEXT,                                   -- unified diff to apply
      draft_files     JSONB,                                  -- [{ path, contents }] for non-diff workflows
      draft_token_count INTEGER,
      drafted_at      TIMESTAMPTZ,
      -- Lila's review
      review_decision TEXT,                                   -- 'approved' | 'rejected'
      review_notes    TEXT,
      review_confidence NUMERIC(3,2),
      reviewed_at     TIMESTAMPTZ,
      -- Submission state
      pr_url          TEXT,
      pr_number       INTEGER,
      submitted_at    TIMESTAMPTZ,
      submit_error    TEXT,
      -- Payout state
      paid_amount_usd NUMERIC(12,2),
      paid_at         TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_bounty_picks_status   ON bounty_picks(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bounty_picks_pending  ON bounty_picks(status, drafted_at)
      WHERE status='discovered' OR status='drafted';
    -- Multi-author rows: Scout used to be the only writer; Forge now also
    -- inserts here. Backfill existing rows to 'scout' so Forge's filter
    -- (WHERE created_by='forge') stays accurate.
    ALTER TABLE bounty_picks ADD COLUMN IF NOT EXISTS created_by TEXT;
    UPDATE bounty_picks SET created_by='scout' WHERE created_by IS NULL;
    CREATE INDEX IF NOT EXISTS idx_bounty_picks_created_by ON bounty_picks(created_by, status, created_at DESC);

    -- ── Scout's gig pipeline (Contra / Wellfound) ────────────────────────
    -- Parallel to bounty_picks but Upwork/Contra-shaped: deliverable is a
    -- short proposal pitch, not a PR diff. No autosubmit — operator sends
    -- proposals manually on the platform.
    CREATE TABLE IF NOT EXISTS gig_picks (
      id              SERIAL      PRIMARY KEY,
      source          TEXT        NOT NULL,                 -- 'contra' | 'wellfound'
      external_id     TEXT        NOT NULL,
      url             TEXT        NOT NULL,
      title           TEXT        NOT NULL,
      summary         TEXT,
      budget_usd      NUMERIC(10,2),
      posted_at       TIMESTAMPTZ,
      status          TEXT        NOT NULL DEFAULT 'discovered',
      draft_pitch     TEXT,
      review_notes    TEXT,
      drafted_at      TIMESTAMPTZ,
      submitted_at    TIMESTAMPTZ,
      paid_at         TIMESTAMPTZ,
      paid_amount_usd NUMERIC(10,2),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gig_picks_status ON gig_picks(status, created_at DESC);

    -- Tutorial-publishing fields on the existing articles table. Scout
    -- writes kind='tutorial' rows; runDevtoPublisher posts approved rows
    -- to dev.to and stamps published_to/published_at. external_url
    -- already exists — we reuse it for the dev.to canonical URL.
    ALTER TABLE articles ADD COLUMN IF NOT EXISTS published_to TEXT;
    ALTER TABLE articles ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_articles_publishable
      ON articles(author, kind, status, published_to)
      WHERE kind='tutorial' AND status='approved' AND published_to IS NULL;

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

    -- ── Walters point-rating framework (NFL only, v3) ───────────────────
    -- True Score: raw final score with ST TDs + late-game garbage stripped.
    -- Used by C1 to update Power Ratings without rewarding lucky bounces.
    ALTER TABLE ceelo_games ADD COLUMN IF NOT EXISTS home_true_score INTEGER;
    ALTER TABLE ceelo_games ADD COLUMN IF NOT EXISTS away_true_score INTEGER;

    -- Walters output block stamped onto each pick — surfaced to operator
    -- alerts and the chat UI so the math is fully traceable.
    ALTER TABLE ceelo_picks ADD COLUMN IF NOT EXISTS raw_pr_diff      NUMERIC(5,2);
    ALTER TABLE ceelo_picks ADD COLUMN IF NOT EXISTS situational_sum  NUMERIC(5,2);
    ALTER TABLE ceelo_picks ADD COLUMN IF NOT EXISTS kelly_units      NUMERIC(4,2);

    -- Ceelo's self-curated player grades. Populated by C0f auto-grading
    -- (no operator input required for v1 — operator can override later).
    --   qb_tier: 1=Elite (7.5pt) … 5=Backup (0pt). Only QBs.
    --   blue_chip_pts: 1.4 (Wirfs-tier OT), 0.9 (top edge / CB), or 0.
    CREATE TABLE IF NOT EXISTS ceelo_player_grades (
      team           TEXT        NOT NULL,
      player         TEXT        NOT NULL,
      position       TEXT        NOT NULL,
      qb_tier        INTEGER,
      blue_chip_pts  NUMERIC(3,2),
      rationale      TEXT,
      graded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (team, player)
    );
    CREATE INDEX IF NOT EXISTS idx_ceelo_player_grades_team
      ON ceelo_player_grades(team, position);
    ALTER TABLE ceelo_state ADD COLUMN IF NOT EXISTS last_grades_at TIMESTAMPTZ;

    -- ── Autonomy tree (hierarchical decision loop) ──────────────────────
    -- Lila navigates a 3-branch tree (DESK / AUTONOMY / LILA) each tick;
    -- at the leaf she emits a 10-step plan persisted in lila_tasks. One
    -- step per tick. Operator can also file inbound desk requests
    -- (direction='to_lila') the tree services.

    -- Operator → Lila inbox + structured request kinds. 'direction' is the
    -- new field that disambiguates legacy agent→operator items
    -- ('to_operator', the default) from operator→Lila inbox ('to_lila')
    -- and lila→teammate routing ('to_agent'). Same desk_items storage,
    -- different consumers — matches the green-line in the operator's tree
    -- diagram where the three DESK boxes are one shared queue viewed from
    -- three angles.
    ALTER TABLE desk_items ADD COLUMN IF NOT EXISTS to_agent  TEXT;
    ALTER TABLE desk_items ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'to_operator';
    ALTER TABLE desk_items ADD COLUMN IF NOT EXISTS category  TEXT;
    ALTER TABLE desk_items ADD COLUMN IF NOT EXISTS payload   JSONB;
    CREATE INDEX IF NOT EXISTS idx_desk_inbound
      ON desk_items(direction, status, created_at)
      WHERE direction='to_lila' AND status='pending';

    -- Bluesky title/category metadata. content stays the published
    -- payload (≤260 chars enforced in compose); title/category surface in
    -- the operator UI so a stream of posts is groupable.
    ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS title    TEXT;
    ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS category TEXT;

    -- @mentions on chat. visible artifact for team updates; the
    -- load-bearing delivery is next_primary on each agent's state row.
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS mentions TEXT[];

    -- Persistent 10-step plan queue. Distinct from lila_state.active_tasks
    -- (which Cipher's BT0 owns for chat-derived task strings). Each plan
    -- groups 10 rows by plan_id; AutonomyLoop executes the lowest-step_no
    -- pending row each tick.
    CREATE TABLE IF NOT EXISTS lila_tasks (
      id           SERIAL      PRIMARY KEY,
      plan_id      UUID        NOT NULL,
      branch_path  TEXT        NOT NULL,
      step_no      INTEGER     NOT NULL,
      description  TEXT        NOT NULL,
      tool         TEXT        NOT NULL,
      args         JSONB       NOT NULL DEFAULT '{}'::jsonb,
      status       TEXT        NOT NULL DEFAULT 'pending',
      result       TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      done_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_lila_tasks_active
      ON lila_tasks(plan_id, step_no) WHERE status='pending';

    -- "NEXT LOOP TASKS PRIMARY" — Lila's TEAM tools write a
    -- {goal,hint?,deadline_at?} JSONB blob here; each agent reads + nulls
    -- it at the top of its own run() so the seed influences exactly one
    -- iteration.
    ALTER TABLE analyst_state    ADD COLUMN IF NOT EXISTS next_primary JSONB;
    ALTER TABLE management_state ADD COLUMN IF NOT EXISTS next_primary JSONB;
    ALTER TABLE ceelo_state      ADD COLUMN IF NOT EXISTS next_primary JSONB;
    ALTER TABLE lila_loop_state  ADD COLUMN IF NOT EXISTS next_primary JSONB;

    -- AutonomyLoop's last-routed leaf (cache so we don't burn an LLM call
    -- when nothing changed). 'last_route_path' = full leaf path joined
    -- with '/'; 'last_route_at' is the timestamp.
    ALTER TABLE management_state ADD COLUMN IF NOT EXISTS last_route_path TEXT;
    ALTER TABLE management_state ADD COLUMN IF NOT EXISTS last_route_at   TIMESTAMPTZ;

    -- Operator-controlled big-red-button. When TRUE, runAgentTick
    -- short-circuits at entry — no subloop runs (trading, vega, cipher,
    -- ceelo, forge, scout, broadcast, lila, none of it). Resume clears
    -- the flag AND resets Lila's tree state (delete pending lila_tasks +
    -- null management_state.last_route_path/at) so she re-routes fresh.
    -- Subloops keep their own internal step/phase intact across pause.
    ALTER TABLE lila_state ADD COLUMN IF NOT EXISTS autonomy_paused BOOLEAN     NOT NULL DEFAULT FALSE;
    ALTER TABLE lila_state ADD COLUMN IF NOT EXISTS paused_at       TIMESTAMPTZ;

    -- Shared coordination primitives readable by all three agents (Lila,
    -- Cipher, Vega). current_priority is the operator's "sticky note" — a
    -- single directive that surfaces in every agent's prompt prefix so a
    -- new instruction doesn't need to be relayed twice. macro_thesis is
    -- the operator's currently-open market thesis, mirrored into Vega's
    -- brief. Provenance for both lives in memory_episodes (source=
    -- 'priority_set' | 'thesis_set'); no audit columns here.
    ALTER TABLE lila_state ADD COLUMN IF NOT EXISTS current_priority TEXT;
    ALTER TABLE lila_state ADD COLUMN IF NOT EXISTS macro_thesis     TEXT;

    -- ── Memory layer (port of PARKSystemsCorporation/2dkira) ────────────
    -- Three-tier word-pair correlation store + Lila-specific extensions
    -- (entities, episodes, summaries, durable message archive). All tables
    -- additive — none reference or alter pre-existing rows. Pruning is
    -- handled by the layer itself (correlations.runDecay, summarize
    -- rollups + retention's optional rolled-up episode sweep). The
    -- existing retention RULES intentionally do NOT include memory_*
    -- tables.

    -- Singleton state row (counter for KIRA's nextIdx + decay/rollup
    -- bookkeeping). Mirrors lila_state pattern.
    CREATE TABLE IF NOT EXISTS memory_state (
      id                    INTEGER     PRIMARY KEY DEFAULT 1,
      counter               BIGINT      NOT NULL DEFAULT 0,
      last_decay_short_at   TIMESTAMPTZ,
      last_decay_medium_at  TIMESTAMPTZ,
      last_decay_long_at    TIMESTAMPTZ,
      last_rollup_hour_at   TIMESTAMPTZ,
      last_rollup_day_at    TIMESTAMPTZ,
      last_rollup_week_at   TIMESTAMPTZ,
      tuning_version        INTEGER     NOT NULL DEFAULT 1,
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO memory_state (id) VALUES (1) ON CONFLICT DO NOTHING;

    -- KIRA's three correlation tiers. Identical column shape across the
    -- three tables so promotion/demotion is DELETE-from-old + INSERT-into-
    -- new (matches 2dkira processMsg verbatim).
    CREATE TABLE IF NOT EXISTS memory_short (
      id        TEXT     PRIMARY KEY,
      pk        TEXT     UNIQUE NOT NULL,
      w1        TEXT     NOT NULL,
      w2        TEXT     NOT NULL,
      p1        TEXT,
      p2        TEXT,
      rel       TEXT,
      sent      TEXT,
      score     REAL     NOT NULL,
      reinf     INTEGER  NOT NULL DEFAULT 1,
      decay_at  BIGINT,
      last_msg  BIGINT,
      created   BIGINT,
      updated   BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_short_w1    ON memory_short(w1);
    CREATE INDEX IF NOT EXISTS idx_memory_short_w2    ON memory_short(w2);
    CREATE INDEX IF NOT EXISTS idx_memory_short_score ON memory_short(score DESC);

    CREATE TABLE IF NOT EXISTS memory_medium (
      id        TEXT     PRIMARY KEY,
      pk        TEXT     UNIQUE NOT NULL,
      w1        TEXT     NOT NULL,
      w2        TEXT     NOT NULL,
      p1        TEXT,
      p2        TEXT,
      rel       TEXT,
      sent      TEXT,
      score     REAL     NOT NULL,
      reinf     INTEGER  NOT NULL DEFAULT 1,
      decay_at  BIGINT,
      last_msg  BIGINT,
      created   BIGINT,
      updated   BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_medium_w1    ON memory_medium(w1);
    CREATE INDEX IF NOT EXISTS idx_memory_medium_w2    ON memory_medium(w2);
    CREATE INDEX IF NOT EXISTS idx_memory_medium_score ON memory_medium(score DESC);

    CREATE TABLE IF NOT EXISTS memory_long (
      id        TEXT     PRIMARY KEY,
      pk        TEXT     UNIQUE NOT NULL,
      w1        TEXT     NOT NULL,
      w2        TEXT     NOT NULL,
      p1        TEXT,
      p2        TEXT,
      rel       TEXT,
      sent      TEXT,
      score     REAL     NOT NULL,
      reinf     INTEGER  NOT NULL DEFAULT 1,
      decay_at  BIGINT,
      last_msg  BIGINT,
      created   BIGINT,
      updated   BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_long_w1    ON memory_long(w1);
    CREATE INDEX IF NOT EXISTS idx_memory_long_w2    ON memory_long(w2);
    CREATE INDEX IF NOT EXISTS idx_memory_long_score ON memory_long(score DESC);

    -- Durable message archive — KIRA's "messages" table. Distinct from
    -- chat_messages (which has 30-day retention and a different schema).
    -- This is the never-pruned conversational record that recall draws on.
    CREATE TABLE IF NOT EXISTS memory_messages (
      id          TEXT      PRIMARY KEY,
      role        TEXT,
      content     TEXT,
      created_at  BIGINT,
      metadata    JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_memory_messages_created ON memory_messages(created_at DESC);

    -- Canonical topic nodes — bounty / codebase / person / ticker / agent
    -- / concept. Lets episodes and summaries point at a stable identifier
    -- so cross-target linking actually means something.
    CREATE TABLE IF NOT EXISTS memory_entities (
      id            BIGSERIAL   PRIMARY KEY,
      kind          TEXT        NOT NULL,
      slug          TEXT        NOT NULL,
      display_name  TEXT        NOT NULL,
      aliases       TEXT[]      NOT NULL DEFAULT '{}'::text[],
      target_id     INTEGER     REFERENCES research_targets(id) ON DELETE SET NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(kind, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entities_slug    ON memory_entities(slug);
    CREATE INDEX IF NOT EXISTS idx_memory_entities_aliases ON memory_entities USING GIN (aliases);

    -- Events on a timeline (Lila-specific; KIRA has no episode table).
    -- target_id makes cross-target recall tractable; entity_id makes
    -- entity-scoped recall tractable.
    CREATE TABLE IF NOT EXISTS memory_summaries (
      id              BIGSERIAL    PRIMARY KEY,
      level           TEXT         NOT NULL,
      window_start    TIMESTAMPTZ  NOT NULL,
      window_end      TIMESTAMPTZ  NOT NULL,
      entity_id       BIGINT       REFERENCES memory_entities(id) ON DELETE SET NULL,
      target_id       INTEGER      REFERENCES research_targets(id) ON DELETE SET NULL,
      content         TEXT         NOT NULL,
      episode_count   INTEGER      NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_memory_summaries_window ON memory_summaries(level, window_end DESC);
    -- Expression-based unique index so writeSummary's ON CONFLICT clause
    -- can match on a stable group key even when entity_id / target_id are
    -- NULL (raw UNIQUE() can't COALESCE).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_summaries_unique
      ON memory_summaries (level, window_start, (COALESCE(entity_id, 0)), (COALESCE(target_id, 0)));

    CREATE TABLE IF NOT EXISTS memory_episodes (
      id              BIGSERIAL    PRIMARY KEY,
      source          TEXT         NOT NULL,
      source_id       TEXT,
      actor           TEXT,
      entity_id       BIGINT       REFERENCES memory_entities(id) ON DELETE SET NULL,
      target_id       INTEGER      REFERENCES research_targets(id) ON DELETE SET NULL,
      content         TEXT         NOT NULL,
      detail          TEXT,
      occurred_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      rolled_up_into  BIGINT       REFERENCES memory_summaries(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_episodes_occurred ON memory_episodes(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_episodes_entity   ON memory_episodes(entity_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_episodes_target   ON memory_episodes(target_id, occurred_at DESC);

    -- One-shot cleanup of legacy side-channel rows + columns. Wipe rows
    -- before dropping the columns those rows reference. All idempotent:
    -- no-op on a fresh DB, single-pass cleanup on existing prod.
    DELETE FROM broadcasts WHERE channel = 'telegram';
    UPDATE memory_episodes SET source = 'chat' WHERE source = 'telegram';

    ALTER TABLE chat_messages    DROP COLUMN IF EXISTS via;
    ALTER TABLE chat_messages    DROP COLUMN IF EXISTS mirrored_at;
    ALTER TABLE security_reports DROP COLUMN IF EXISTS tg_alerted_at;
    ALTER TABLE ceelo_picks      DROP COLUMN IF EXISTS tg_alerted_at;
    ALTER TABLE lila_positions   DROP COLUMN IF EXISTS tg_alerted_at;
    ALTER TABLE bounty_picks     DROP COLUMN IF EXISTS tg_alerted_at;
    DROP INDEX  IF EXISTS idx_chat_messages_mirror;
  `)
  schemaReady = true
}
