import type { PoolClient } from 'pg'
import OpenAI from 'openai'
import { cfg } from './config'
import { maybeRunSummaries } from './memory/summarize'
import { runDecay } from './memory/correlations'

// Daily retention pass. Trims log/usage/chat/broadcast rows older than their
// per-table TTL. Financial tables (security_reports, lila_positions,
// watch_targets, research_targets) are NEVER touched. The yard's daily
// wipe is the one exception — analyst_picks rows with asset_class='etf/macro'
// from before today UTC get hard-deleted here, since the yard board renders
// today's picks only.
// Memory tables (memory_*) are also NEVER touched here — they self-decay
// via correlations.runDecay + summarize rollups, with rolled-up episodes
// pruned by the dedicated sweep below.
//
// Gated by management_state.last_retention_at. Runs at most once per 24h.

const DAY_MS = 24 * 60 * 60 * 1000

const RULES: Array<{ table: string; interval: string; cond?: string }> = [
  { table: 'lila_log',       interval: '14 days' },
  { table: 'llm_usage',      interval: '60 days' },
  { table: 'broadcasts',     interval: '60 days' },
  { table: 'chat_messages',  interval: '30 days' },
  {
    table: 'research_notes',
    interval: '90 days',
    // Keep arch/surfaces/invariants forever — those are the research memory.
    // Only prune accumulated hypothesis dust and evidence.
    cond: `kind IN ('evidence', 'hypothesis:closed')`,
  },
]

export interface RetentionResult {
  ran: boolean
  deleted: Record<string, number>
  logMessage: string
  logType: 'info' | 'success' | 'warn'
}

export async function runRetention(db: PoolClient, force = false): Promise<RetentionResult | null> {
  if (!cfg.ENABLE_RETENTION) return null

  if (!force) {
    const { rows: [s] } = await db.query(
      'SELECT last_retention_at FROM management_state WHERE id=1'
    )
    if (s?.last_retention_at) {
      const since = Date.now() - new Date(s.last_retention_at).getTime()
      if (since < DAY_MS) return null
    }
  }

  const deleted: Record<string, number> = {}
  let totalDeleted = 0

  for (const rule of RULES) {
    try {
      const where = rule.cond
        ? `created_at < NOW() - INTERVAL '${rule.interval}' AND (${rule.cond})`
        : `created_at < NOW() - INTERVAL '${rule.interval}'`
      const res = await db.query(`DELETE FROM ${rule.table} WHERE ${where}`)
      const n = res.rowCount ?? 0
      deleted[rule.table] = n
      totalDeleted += n
    } catch {
      // If any single table fails (missing column, etc.), keep going.
      deleted[rule.table] = -1
    }
  }

  // The yard's daily wipe. Hard-delete commodity/macro picks from before
  // today UTC. Other asset_classes (stock from /api/analyst, anything else)
  // are never touched. Idempotent — re-running on the same day is a no-op.
  try {
    const res = await db.query(
      `DELETE FROM analyst_picks
        WHERE asset_class = 'etf/macro'
          AND created_at < date_trunc('day', NOW() AT TIME ZONE 'UTC')`
    )
    const n = res.rowCount ?? 0
    if (n > 0) {
      deleted['analyst_picks(yard)'] = n
      totalDeleted += n
    }
  } catch {
    deleted['analyst_picks(yard)'] = -1
  }

  // Memory backstop — daily ceiling on summarization latency + correlation
  // decay. Both are internally gated, so re-running is cheap. Errors are
  // swallowed; retention's primary job is row pruning.
  if (process.env.DEEPSEEK_API_KEY) {
    try {
      const ai = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
      await maybeRunSummaries(db, ai)
    } catch { /* best-effort */ }
  }
  try { await runDecay(db) } catch { /* best-effort */ }

  // Hard-delete memory_episodes that have already been rolled up into a
  // summary AND are older than 90 days — keeps the table from growing
  // unbounded after long-running deploys.
  try {
    const res = await db.query(
      `DELETE FROM memory_episodes
        WHERE rolled_up_into IS NOT NULL
          AND occurred_at < NOW() - INTERVAL '90 days'`
    )
    if (res.rowCount && res.rowCount > 0) {
      deleted['memory_episodes(rolled-up)'] = res.rowCount
      totalDeleted += res.rowCount
    }
  } catch { /* best-effort */ }

  await db.query(
    'UPDATE management_state SET last_retention_at=NOW(), updated_at=NOW() WHERE id=1'
  )

  const summary = Object.entries(deleted)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${t}: ${n}`)
    .join(', ') || 'nothing expired'

  return {
    ran: true,
    deleted,
    logMessage: `Retention pass complete · ${summary}.`,
    logType: totalDeleted > 0 ? 'success' : 'info',
  }
}
