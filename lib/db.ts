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

    -- Ceelo: thoroughbred-racing yield engine. Posts win-market picks based
    -- on per-runner fair-odds edge; operator decides which to take and
    -- marks W/L. Strictly informational — no auto-execution. Bankroll lives
    -- entirely in operator-entered stake/payout amounts on each pick.
    --
    -- Migration: this block runs once. If we still see the old NFL-shaped
    -- ceelo_picks (the "sport" column is the cheapest sentinel), drop the
    -- entire pre-racing surface so the CREATE statements below land on a
    -- clean slate. The drop wipes existing NFL/NBA/MLB picks history;
    -- the swap to racing was authorised with that loss in mind.
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='ceelo_picks' AND column_name='sport'
      ) OR EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name='ceelo_games'
      ) THEN
        DROP TABLE IF EXISTS ceelo_picks         CASCADE;
        DROP TABLE IF EXISTS ceelo_lines         CASCADE;
        DROP TABLE IF EXISTS ceelo_model_lines   CASCADE;
        DROP TABLE IF EXISTS ceelo_games         CASCADE;
        DROP TABLE IF EXISTS ceelo_team_ratings  CASCADE;
        DROP TABLE IF EXISTS ceelo_team_epa      CASCADE;
        DROP TABLE IF EXISTS ceelo_depth_charts  CASCADE;
        DROP TABLE IF EXISTS ceelo_rosters       CASCADE;
        DROP TABLE IF EXISTS ceelo_injuries      CASCADE;
        DROP TABLE IF EXISTS ceelo_player_grades CASCADE;
        DROP TABLE IF EXISTS ceelo_backfill      CASCADE;
        DROP TABLE IF EXISTS ceelo_backtest      CASCADE;
        DROP TABLE IF EXISTS ceelo_state         CASCADE;
        DROP TABLE IF EXISTS horse_state         CASCADE;
      END IF;
    END $$;

    -- One row per scheduled race, keyed by the Racing API's race_id.
    CREATE TABLE IF NOT EXISTS ceelo_races (
      race_id      TEXT        PRIMARY KEY,
      course       TEXT        NOT NULL,
      off_dt       TIMESTAMPTZ NOT NULL,
      off_time     TEXT        NOT NULL,          -- 'HH:MM' local to course
      race_name    TEXT        NOT NULL,
      distance     TEXT,
      going        TEXT,
      type         TEXT,                          -- Flat / Hurdle / Chase
      field_size   INTEGER     NOT NULL DEFAULT 0,
      status       TEXT        NOT NULL DEFAULT 'scheduled', -- scheduled | off | final
      finished_at  TIMESTAMPTZ,
      refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ceelo_races_off_dt ON ceelo_races(off_dt);
    CREATE INDEX IF NOT EXISTS idx_ceelo_races_status ON ceelo_races(status, off_dt);

    -- One row per runner per race.
    CREATE TABLE IF NOT EXISTS ceelo_runners (
      race_id    TEXT    NOT NULL REFERENCES ceelo_races(race_id) ON DELETE CASCADE,
      horse_id   TEXT    NOT NULL,
      horse      TEXT    NOT NULL,
      number     INTEGER,
      draw       INTEGER,
      jockey     TEXT,
      trainer    TEXT,
      age        INTEGER,
      weight_lbs INTEGER,
      form       TEXT,
      PRIMARY KEY (race_id, horse_id)
    );

    -- Per-runner odds snapshots. One row per (race, horse, fetched_at).
    -- Latest row drives the EdgeBoard; historical rows feed velocity.
    CREATE TABLE IF NOT EXISTS ceelo_runner_odds (
      id            SERIAL      PRIMARY KEY,
      race_id       TEXT        NOT NULL REFERENCES ceelo_races(race_id) ON DELETE CASCADE,
      horse_id      TEXT        NOT NULL,
      odds_decimal  NUMERIC(8,2),
      fair_decimal  NUMERIC(8,2),
      edge_pct      NUMERIC(6,2),
      fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ceelo_runner_odds_race
      ON ceelo_runner_odds(race_id, horse_id, fetched_at DESC);

    -- Race results. One row per race once status='final'.
    CREATE TABLE IF NOT EXISTS ceelo_results (
      race_id       TEXT        PRIMARY KEY REFERENCES ceelo_races(race_id) ON DELETE CASCADE,
      finished_at   TIMESTAMPTZ NOT NULL,
      winner_id     TEXT,
      winner_sp     NUMERIC(8,2),
      finishers     JSONB       NOT NULL DEFAULT '[]'::jsonb
    );

    -- Picks — racing shape. Reuses the operator workflow (status enum) and
    -- the auto-grading split (status=operator's W/L; model_outcome=Ceelo's
    -- hypothetical W/L regardless of whether the operator took the pick).
    CREATE TABLE IF NOT EXISTS ceelo_picks (
      id              SERIAL      PRIMARY KEY,
      race_id         TEXT        REFERENCES ceelo_races(race_id) ON DELETE SET NULL,
      horse_id        TEXT,
      race_label      TEXT        NOT NULL,           -- e.g. "14:30 Ascot — Soft 7f"
      horse_name      TEXT        NOT NULL,
      market          TEXT        NOT NULL DEFAULT 'win',
      off_dt          TIMESTAMPTZ,
      model_prob      NUMERIC(4,3),
      fair_decimal    NUMERIC(8,2),
      book_decimal    NUMERIC(8,2),
      edge_pct        NUMERIC(6,2),
      intensity       INTEGER,                         -- 1..10 from yield engine
      velocity        TEXT,                            -- 'up'|'down'|'flat'
      reasoning       TEXT        NOT NULL,
      confidence      TEXT        NOT NULL DEFAULT 'yellow',  -- 'green'|'yellow'|'red'
      source          TEXT        NOT NULL DEFAULT 'model',   -- 'model' | 'llm'
      status          TEXT        NOT NULL DEFAULT 'open',
                                    -- open | skipped | taken | won | lost | push | void
      stake           NUMERIC(10,2),
      taken_odds      NUMERIC(8,2),                    -- decimal odds the operator got
      payout          NUMERIC(10,2),                   -- net P&L (stake-relative); push/void = 0
      taken_at        TIMESTAMPTZ,
      settled_at      TIMESTAMPTZ,
      model_outcome   TEXT,                            -- 'win'|'loss'|'push'|NULL
      model_graded_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ceelo_picks_status ON ceelo_picks(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ceelo_picks_off_dt ON ceelo_picks(off_dt);
    CREATE INDEX IF NOT EXISTS idx_ceelo_picks_race   ON ceelo_picks(race_id);
    CREATE INDEX IF NOT EXISTS idx_ceelo_picks_model_outcome
      ON ceelo_picks(model_outcome) WHERE source='model';

    CREATE TABLE IF NOT EXISTS ceelo_state (
      id              INTEGER     PRIMARY KEY DEFAULT 1,
      cycle           INTEGER     NOT NULL DEFAULT 0,
      last_run_at     TIMESTAMPTZ,
      last_schedule_at TIMESTAMPTZ,                    -- C0 racecard refresh
      last_grade_at   TIMESTAMPTZ,                     -- C1 result grading
      last_odds_at    TIMESTAMPTZ,                     -- C2 per-runner odds snapshot
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO ceelo_state (id) VALUES (1) ON CONFLICT DO NOTHING;

    -- Phase 2 (NA): additive migrations on the racing tables. All
    -- idempotent so re-running ensureSchema is a no-op.
    --
    -- country: ISO3 ('USA' | 'CAN') stamped from the meet payload so
    -- operator-side filtering ('WHERE country=...') is one column away
    -- without a join to a meets table.
    ALTER TABLE ceelo_races   ADD COLUMN IF NOT EXISTS country TEXT;
    CREATE INDEX IF NOT EXISTS idx_ceelo_races_country_off
      ON ceelo_races(country, off_dt);

    -- Program number was INTEGER under the UK-only Phase 1 (cloth
    -- numbers are always integers); NA coupled entries arrive as "1A"
    -- / "1B" and need to survive verbatim for display. The yield
    -- engine never reads this field for math.
    ALTER TABLE ceelo_runners ALTER COLUMN number TYPE TEXT USING number::TEXT;

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

    -- ── Scout's gig pipeline (RemoteOK / WeWorkRemotely) ───────────────
    -- Parallel to bounty_picks but gig-shaped: deliverable is a short
    -- proposal pitch, not a PR diff. No autosubmit — operator sends
    -- proposals manually on the platform.
    CREATE TABLE IF NOT EXISTS gig_picks (
      id              SERIAL      PRIMARY KEY,
      source          TEXT        NOT NULL,                 -- 'remoteok' | 'weworkremotely'
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

    -- Ceelo per-phase observability. Each c0..c5 phase persists its last
    -- error message (NULL when the phase last succeeded); last_phase_at
    -- is a JSONB map { c0: iso, c1: iso, ... } stamped on success. Lets
    -- /api/ceelo/diag and the operator panel surface phase health
    -- without a new table.
    ALTER TABLE ceelo_state ADD COLUMN IF NOT EXISTS last_c0_error TEXT;
    ALTER TABLE ceelo_state ADD COLUMN IF NOT EXISTS last_c1_error TEXT;
    ALTER TABLE ceelo_state ADD COLUMN IF NOT EXISTS last_c2_error TEXT;
    ALTER TABLE ceelo_state ADD COLUMN IF NOT EXISTS last_c3_error TEXT;
    ALTER TABLE ceelo_state ADD COLUMN IF NOT EXISTS last_c4_error TEXT;
    ALTER TABLE ceelo_state ADD COLUMN IF NOT EXISTS last_c5_error TEXT;
    ALTER TABLE ceelo_state ADD COLUMN IF NOT EXISTS last_phase_at  JSONB;

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
    ALTER TABLE lila_positions   DROP COLUMN IF EXISTS tg_alerted_at;
    ALTER TABLE bounty_picks     DROP COLUMN IF EXISTS tg_alerted_at;
    DROP INDEX  IF EXISTS idx_chat_messages_mirror;

    -- Sports ingestion (API-Sports + ParlayAPI + ProphetX). We persist
    -- only our interpretations — the 1–10 scores and the small numeric
    -- inputs that produced them. No raw upstream payloads.
    CREATE TABLE IF NOT EXISTS sports_teams (
      team_id     TEXT         PRIMARY KEY,
      city        TEXT         NOT NULL,
      name        TEXT         NOT NULL,
      league      TEXT         NOT NULL,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (league, city, name)
    );

    CREATE TABLE IF NOT EXISTS sports_games (
      game_id        TEXT         PRIMARY KEY,
      league         TEXT         NOT NULL,
      home_team_id   TEXT         NOT NULL REFERENCES sports_teams(team_id),
      away_team_id   TEXT         NOT NULL REFERENCES sports_teams(team_id),
      tipoff_at      TIMESTAMPTZ  NOT NULL,
      status         TEXT         NOT NULL,
      pct_game_left  NUMERIC(4,3),
      updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS sports_games_league_status_idx
      ON sports_games (league, status, tipoff_at);

    CREATE TABLE IF NOT EXISTS sports_signals (
      id          SERIAL       PRIMARY KEY,
      game_id     TEXT         NOT NULL REFERENCES sports_games(game_id),
      team_id     TEXT         NOT NULL REFERENCES sports_teams(team_id),
      metric      TEXT         NOT NULL,
      score       SMALLINT     NOT NULL,
      inputs      JSONB        NOT NULL,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS sports_signals_game_idx
      ON sports_signals (game_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS sports_signals_team_metric_idx
      ON sports_signals (team_id, metric, created_at DESC);

    CREATE TABLE IF NOT EXISTS sports_game_view (
      game_id          TEXT         NOT NULL,
      team_id          TEXT         NOT NULL,
      is_lead_team     BOOLEAN      NOT NULL,
      overround_1to10  SMALLINT,
      consensus_1to10  SMALLINT,
      pct_game_left    NUMERIC(4,3),
      lead_pct         NUMERIC(4,3),
      sma10_1to10      SMALLINT,
      steam_1to10      SMALLINT,
      delta_1to10      SMALLINT,
      composite_1to10  SMALLINT     NOT NULL,
      color_tier       TEXT         NOT NULL,
      updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      PRIMARY KEY (game_id, team_id)
    );

    CREATE TABLE IF NOT EXISTS sports_game_events (
      id            SERIAL       PRIMARY KEY,
      game_id       TEXT         NOT NULL,
      team_id       TEXT         NOT NULL,
      kind          TEXT         NOT NULL,
      team_in_lead  BOOLEAN      NOT NULL,
      during_pull   BOOLEAN      NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS sports_game_events_game_idx
      ON sports_game_events (game_id, created_at);

    -- Rolling 30-day jockey / trainer strike rates. Rolled up nightly
    -- from the racing results endpoint by lib/horse-racing/stats-rollup.
    -- The per-runner scoreAllRunners() reads win_rate to bias the
    -- composite signal in favour of in-form connections.
    CREATE TABLE IF NOT EXISTS jockey_stats (
      name        TEXT          PRIMARY KEY,
      runs_30d    INT           NOT NULL DEFAULT 0,
      wins_30d    INT           NOT NULL DEFAULT 0,
      win_rate    NUMERIC(5,4),
      updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS trainer_stats (
      name        TEXT          PRIMARY KEY,
      runs_30d    INT           NOT NULL DEFAULT 0,
      wins_30d    INT           NOT NULL DEFAULT 0,
      win_rate    NUMERIC(5,4),
      updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );

    -- ─────────────────────────────────────────────────────────────────────
    -- The Bazaar — encrypted agent-labor market settled in $LDGR on Solana.
    -- viewer_dms + park_gates_ledger stay read-only as legacy history.
    -- ─────────────────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS bazaar_agents (
      id                   BIGSERIAL    PRIMARY KEY,
      viewer_id            INTEGER      REFERENCES viewers(id) ON DELETE SET NULL,
      matrix_user_id       TEXT         UNIQUE NOT NULL,
      display_name         TEXT         NOT NULL,
      bio                  TEXT,
      phantom_wallet       TEXT,
      api_token_hash       TEXT,
      status               TEXT         NOT NULL DEFAULT 'pending',
      device_verified_at   TIMESTAMPTZ,
      approved_at          TIMESTAMPTZ,
      banned_at            TIMESTAMPTZ,
      created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bazaar_agents_status
      ON bazaar_agents (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bazaar_agents_wallet
      ON bazaar_agents (phantom_wallet) WHERE phantom_wallet IS NOT NULL;

    CREATE TABLE IF NOT EXISTS bazaar_skills (
      id                BIGSERIAL    PRIMARY KEY,
      agent_id          BIGINT       NOT NULL REFERENCES bazaar_agents(id) ON DELETE CASCADE,
      title             TEXT         NOT NULL,
      body              TEXT         NOT NULL,
      price_ldgr_min    NUMERIC(20,9) NOT NULL,
      currency          TEXT         NOT NULL DEFAULT 'LDGR',
      room_event_id     TEXT,
      posted_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      retired_at        TIMESTAMPTZ,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bazaar_skills_agent
      ON bazaar_skills (agent_id, posted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bazaar_skills_live
      ON bazaar_skills (posted_at DESC) WHERE retired_at IS NULL;

    CREATE TABLE IF NOT EXISTS bazaar_rooms (
      id                BIGSERIAL    PRIMARY KEY,
      matrix_room_id    TEXT         UNIQUE NOT NULL,
      kind              TEXT         NOT NULL,
      hirer_agent_id    BIGINT       REFERENCES bazaar_agents(id),
      worker_agent_id   BIGINT       REFERENCES bazaar_agents(id),
      gig_id            BIGINT,
      state             TEXT         NOT NULL DEFAULT 'open',
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      archived_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_bazaar_rooms_kind
      ON bazaar_rooms (kind, state, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bazaar_rooms_gig
      ON bazaar_rooms (gig_id) WHERE gig_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS bazaar_gigs (
      id                BIGSERIAL    PRIMARY KEY,
      hirer_agent_id    BIGINT       NOT NULL REFERENCES bazaar_agents(id),
      worker_agent_id   BIGINT       NOT NULL REFERENCES bazaar_agents(id),
      skill_id          BIGINT       REFERENCES bazaar_skills(id),
      room_id           BIGINT       REFERENCES bazaar_rooms(id),
      brief_md          TEXT         NOT NULL,
      milestones        JSONB        NOT NULL DEFAULT '[]'::jsonb,
      total_ldgr        NUMERIC(20,9) NOT NULL DEFAULT 0,
      escrow_pda        TEXT,
      state             TEXT         NOT NULL DEFAULT 'negotiating',
      disputed_reason   TEXT,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      funded_at         TIMESTAMPTZ,
      released_at       TIMESTAMPTZ,
      refunded_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_bazaar_gigs_hirer
      ON bazaar_gigs (hirer_agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bazaar_gigs_worker
      ON bazaar_gigs (worker_agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bazaar_gigs_state
      ON bazaar_gigs (state, created_at DESC);

    CREATE TABLE IF NOT EXISTS bazaar_milestones (
      id                BIGSERIAL    PRIMARY KEY,
      gig_id            BIGINT       NOT NULL REFERENCES bazaar_gigs(id) ON DELETE CASCADE,
      idx               SMALLINT     NOT NULL,
      description       TEXT         NOT NULL,
      amount_ldgr       NUMERIC(20,9) NOT NULL,
      state             TEXT         NOT NULL DEFAULT 'pending',
      proof_event_id    TEXT,
      submitted_at      TIMESTAMPTZ,
      verified_at       TIMESTAMPTZ,
      released_at       TIMESTAMPTZ,
      release_tx_sig    TEXT,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (gig_id, idx)
    );
    CREATE INDEX IF NOT EXISTS idx_bazaar_milestones_state
      ON bazaar_milestones (state, submitted_at DESC NULLS LAST);

    CREATE TABLE IF NOT EXISTS bazaar_escrows (
      id                BIGSERIAL    PRIMARY KEY,
      gig_id            BIGINT       NOT NULL UNIQUE REFERENCES bazaar_gigs(id) ON DELETE CASCADE,
      program_id        TEXT         NOT NULL,
      escrow_pda        TEXT         NOT NULL,
      vault_ata         TEXT         NOT NULL,
      mint              TEXT         NOT NULL,
      moderator_pubkey  TEXT         NOT NULL,
      amount_total      NUMERIC(20,9) NOT NULL,
      tx_sig_init       TEXT,
      tx_sig_release    TEXT,
      tx_sig_refund     TEXT,
      state             TEXT         NOT NULL DEFAULT 'pending_init',
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bazaar_ledger (
      id            BIGSERIAL    PRIMARY KEY,
      actor         TEXT         NOT NULL,
      action        TEXT         NOT NULL,
      gig_id        BIGINT       REFERENCES bazaar_gigs(id) ON DELETE SET NULL,
      agent_id      BIGINT       REFERENCES bazaar_agents(id) ON DELETE SET NULL,
      room_id       BIGINT       REFERENCES bazaar_rooms(id) ON DELETE SET NULL,
      refs          JSONB        NOT NULL DEFAULT '{}'::jsonb,
      tx_sig        TEXT,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bazaar_ledger_recent
      ON bazaar_ledger (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bazaar_ledger_gig
      ON bazaar_ledger (gig_id, created_at DESC) WHERE gig_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_bazaar_ledger_action
      ON bazaar_ledger (action, created_at DESC);

    -- One-shot Park Gates → $LDGR bridge. UNIQUE on viewer_id guards against
    -- double-mint races; the bridge route inserts this row before sending the
    -- mint tx and rolls back if the chain call fails.
    CREATE TABLE IF NOT EXISTS pg_to_ldgr_bridge (
      id              BIGSERIAL    PRIMARY KEY,
      viewer_id       INTEGER      NOT NULL UNIQUE REFERENCES viewers(id) ON DELETE CASCADE,
      pg_burned       INTEGER      NOT NULL,
      ldgr_minted     NUMERIC(20,9) NOT NULL,
      phantom_wallet  TEXT         NOT NULL,
      tx_sig          TEXT,
      bridged_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );

    -- Cross-table FK back-patched once both tables exist.
    DO $bazaar_fk$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'bazaar_rooms_gig_fk'
      ) THEN
        ALTER TABLE bazaar_rooms
          ADD CONSTRAINT bazaar_rooms_gig_fk
          FOREIGN KEY (gig_id) REFERENCES bazaar_gigs(id) ON DELETE SET NULL;
      END IF;
    END $bazaar_fk$;
  `)
  schemaReady = true
}
