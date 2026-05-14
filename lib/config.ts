// Centralized env-driven knobs. Set any of these on Railway to tune without
// a code change.

function num(key: string, fallback: number): number {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  return v.toLowerCase() !== 'false' && v !== '0'
}

export const cfg = Object.freeze({
  // ── Cadence (seconds unless noted) ───────────────────────────────────────
  // Minimum spacing between Cipher step advances.
  TASKER_STEP_SEC:        num('TASKER_STEP_SEC', 30),
  // Minimum spacing between research cycles on the SAME pinned target.
  // Bigger = fewer deep-research burns, more room for cheap bounty work.
  RESEARCH_CYCLE_SEC:     num('RESEARCH_CYCLE_SEC', 180),
  // Vega step interval (minutes).
  ANALYST_STEP_MIN:       num('ANALYST_STEP_MIN', 2),
  // Ceelo run interval (minutes). State-machine cycle ticks; each step is
  // internally rate-limited so this can be aggressive without spamming
  // upstream sources.
  CEELO_RUN_MIN:          num('CEELO_RUN_MIN', 30),
  // Scout step interval (seconds). Gig hunter (RemoteOK/WWR) +
  // tutorial fallback. One target per cycle.
  SCOUT_RUN_SEC:          num('SCOUT_RUN_SEC', 300),
  // Hours of empty RemoteOK/WWR fetches before Scout switches to
  // tutorial-drafting mode. Set to 0 to force tutorial drafting on the
  // next cycle (used in tests / verification).
  SCOUT_DRY_HOURS:        num('SCOUT_DRY_HOURS', 24),
  // Forge step interval (seconds). Fast Algora-only PR drafter — same
  // shape as Scout's old volume cycle, scoped to $50-$200 Bug/Feature.
  FORGE_RUN_SEC:          num('FORGE_RUN_SEC', 300),
  // Artist step interval (seconds). One piece per cycle via fal.ai
  // FLUX.1 schnell. Default 1h — adjust down for testing.
  ARTIST_RUN_SEC:         num('ARTIST_RUN_SEC', 3600),
  // Soft cap on dollars/day spent on artist generations. At ~$0.003
  // per FLUX schnell render, $1 → ~333 pieces/day worst case.
  ARTIST_DAILY_BUDGET_USD: num('ARTIST_DAILY_BUDGET_USD', 1),
  // Broadcast loop: one public post attempt every N minutes. Silent hours
  // skip automatically (no spam when nothing notable happened).
  BROADCAST_INTERVAL_MIN: num('BROADCAST_INTERVAL_MIN', 60),
  // Grace window between composing a broadcast and actually posting it.
  // The preview is logged so the operator can Cancel or Publish Now from
  // Dash before it hits the feed. 0 = publish immediately (no preview).
  BROADCAST_PREVIEW_WINDOW_MIN: num('BROADCAST_PREVIEW_WINDOW_MIN', 5),
  // Server autonomy ticker interval (ms).
  AUTONOMY_TICK_MS:       num('AUTONOMY_TICK_MS', 30_000),
  // Horse-racing loop interval (seconds). Keeps the racecard / odds
  // cache warm and emits a digest log entry. Internally rate-limited
  // to 1 RPS by lib/horse-racing/rate-limiter.ts, so this can stay
  // aggressive without burning the free-tier quota.
  HORSE_RUN_SEC:          num('HORSE_RUN_SEC', 300),
  // Sports ingestion (API-Sports / ParlayAPI / ProphetX) tick interval
  // in ms. Gated by ENABLE_SPORTS_LOOP=true; otherwise the loop no-ops.
  SPORTS_TICK_MS:         num('SPORTS_TICK_MS', 60_000),

  // ── Budget ───────────────────────────────────────────────────────────────
  // Daily USD cap on background LLM spend. 0 = no cap. Chat streaming is
  // excluded (operator-facing); only background loops get paused when
  // the day's logged spend reaches this.
  DAILY_LLM_BUDGET_USD:   num('DAILY_LLM_BUDGET_USD', 5),
  // DeepSeek pricing (USD per 1M tokens). Override if pricing changes.
  PRICE_IN_PER_M:         num('DEEPSEEK_PRICE_IN_PER_M', 0.27),
  PRICE_OUT_PER_M:        num('DEEPSEEK_PRICE_OUT_PER_M', 1.10),

  // ── Switches ─────────────────────────────────────────────────────────────
  ENABLE_AUTONOMY_TICKER: bool('ENABLE_AUTONOMY_TICKER', true),
  ENABLE_BROADCAST:       bool('ENABLE_BROADCAST', true),
  // Horse-racing loop kill-switch. Default on; flip off to silence the
  // loop without removing the upstream credentials.
  ENABLE_HORSE_RACING:    bool('ENABLE_HORSE_RACING', true),
  // Daily DELETE of stale log / token-usage / chat / broadcast / hypothesis
  // rows so Postgres doesn't grow forever. Financial tables (security_reports,
  // lila_positions, analyst_picks, watch_targets, research_targets) are never
  // touched.
  ENABLE_RETENTION:       bool('ENABLE_RETENTION', true),

  // ── Autonomy tree ────────────────────────────────────────────────────────
  // Reuse last-routed leaf for this many seconds when nothing changed
  // (no new inbound desk row, no unanswered operator message). Saves the
  // routing LLM call when the loop would otherwise repeat the same pick.
  LILA_TREE_CACHE_SEC:    num('LILA_TREE_CACHE_SEC', 300),
  // Comma-separated host suffixes the SOLO web-fetch tool will hit.
  // Empty = a sensible default list. Hosts match by suffix so e.g.
  // 'github.com' matches 'raw.githubusercontent.com' as well via separate
  // entries below.
  LILA_WEB_ALLOWLIST:     process.env.LILA_WEB_ALLOWLIST ??
    'github.com,raw.githubusercontent.com,news.ycombinator.com,en.wikipedia.org,arxiv.org',
  // When true, all autonomy tools become no-ops that record their intent
  // but produce no side effects. Intended for dev-autonomy-tick.ts.
  LILA_DRY_RUN:           bool('LILA_DRY_RUN', false),
  // Gate code.run_tests behind an explicit opt-in so Lila never shells
  // out to npm test without operator authorization.
  LILA_RUN_TESTS:         bool('LILA_RUN_TESTS', false),
})
