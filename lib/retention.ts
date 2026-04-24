import type { PoolClient } from 'pg'
import { cfg } from './config'

// Daily retention pass. Trims log/usage/chat/broadcast rows older than their
// per-table TTL. Financial tables (security_reports, lila_positions,
// analyst_picks, watch_targets, research_targets) are NEVER touched.
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
