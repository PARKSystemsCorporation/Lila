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
  // Minimum spacing between Tasker step advances.
  TASKER_STEP_SEC:        num('TASKER_STEP_SEC', 30),
  // Minimum spacing between research cycles on the SAME pinned target.
  // Bigger = fewer deep-research burns, more room for cheap bounty work.
  RESEARCH_CYCLE_SEC:     num('RESEARCH_CYCLE_SEC', 180),
  // Management proactive check-in interval.
  MANAGEMENT_CHECK_SEC:   num('MANAGEMENT_CHECK_SEC', 300),
  // Trade cycle interval (Lila).
  MANAGEMENT_TRADE_SEC:   num('MANAGEMENT_TRADE_SEC', 900),
  // Analyst step interval (minutes).
  ANALYST_STEP_MIN:       num('ANALYST_STEP_MIN', 2),
  // Broadcast loop: one public post attempt every N minutes. Silent hours
  // skip automatically (no spam when nothing notable happened).
  BROADCAST_INTERVAL_MIN: num('BROADCAST_INTERVAL_MIN', 60),
  // Server autonomy ticker interval (ms).
  AUTONOMY_TICK_MS:       num('AUTONOMY_TICK_MS', 30_000),

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
  // Daily DELETE of stale log / token-usage / chat / broadcast / hypothesis
  // rows so Postgres doesn't grow forever. Financial tables (security_reports,
  // lila_positions, analyst_picks, watch_targets, research_targets) are never
  // touched.
  ENABLE_RETENTION:       bool('ENABLE_RETENTION', true),
})
