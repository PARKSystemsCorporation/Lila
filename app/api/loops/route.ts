import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { cfg } from '@/lib/config'

export const dynamic = 'force-dynamic'

// Single snapshot of every autonomous loop's last-fired timestamp plus the
// expected cadence, so the Dash LoopsCard can render "fired Xs ago · next in Ys"
// and flag overdue loops as warnings.

interface LoopRow {
  key: string
  label: string
  last_at: number | null      // unix ms, null if never fired
  interval_sec: number        // expected spacing
  next_at: number | null
}

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ loops: [] })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const [tasker, analyst, mgmt, broadcast, discovery, research] = await Promise.all([
      db.query(`SELECT (EXTRACT(EPOCH FROM last_step_at) * 1000)::bigint AS ts FROM lila_loop_state WHERE id=1`),
      db.query(`SELECT (EXTRACT(EPOCH FROM last_step_at) * 1000)::bigint AS ts FROM analyst_state   WHERE id=1`),
      db.query(`SELECT
                  (EXTRACT(EPOCH FROM last_check_at) * 1000)::bigint AS check_ts,
                  (EXTRACT(EPOCH FROM last_trade_at) * 1000)::bigint AS trade_ts
                FROM management_state WHERE id=1`),
      db.query(`SELECT (EXTRACT(EPOCH FROM last_broadcast_at) * 1000)::bigint AS ts FROM broadcast_state WHERE id=1`),
      db.query(`SELECT (EXTRACT(EPOCH FROM last_run_at) * 1000)::bigint AS ts FROM discovery_state WHERE id=1`),
      db.query(`SELECT title, phase, (EXTRACT(EPOCH FROM last_worked_at) * 1000)::bigint AS ts
                FROM research_targets WHERE status='active'
                ORDER BY last_worked_at DESC NULLS LAST LIMIT 1`),
    ])

    const loops: LoopRow[] = [
      {
        key: 'tasker',
        label: 'Tasker',
        last_at: tasker.rows[0]?.ts ? Number(tasker.rows[0].ts) : null,
        interval_sec: cfg.TASKER_STEP_SEC,
        next_at: nextAt(tasker.rows[0]?.ts, cfg.TASKER_STEP_SEC * 1000),
      },
      {
        key: 'analyst',
        label: 'Analyst',
        last_at: analyst.rows[0]?.ts ? Number(analyst.rows[0].ts) : null,
        interval_sec: cfg.ANALYST_STEP_MIN * 60,
        next_at: nextAt(analyst.rows[0]?.ts, cfg.ANALYST_STEP_MIN * 60_000),
      },
      {
        key: 'management.check',
        label: 'Lila check-in',
        last_at: mgmt.rows[0]?.check_ts ? Number(mgmt.rows[0].check_ts) : null,
        interval_sec: cfg.MANAGEMENT_CHECK_SEC,
        next_at: nextAt(mgmt.rows[0]?.check_ts, cfg.MANAGEMENT_CHECK_SEC * 1000),
      },
      {
        key: 'management.trade',
        label: 'Lila trade cycle',
        last_at: mgmt.rows[0]?.trade_ts ? Number(mgmt.rows[0].trade_ts) : null,
        interval_sec: cfg.MANAGEMENT_TRADE_SEC,
        next_at: nextAt(mgmt.rows[0]?.trade_ts, cfg.MANAGEMENT_TRADE_SEC * 1000),
      },
      {
        key: 'research',
        label: research.rows[0]
          ? `Research · ${String(research.rows[0].title).slice(0, 30)}`
          : 'Research',
        last_at: research.rows[0]?.ts ? Number(research.rows[0].ts) : null,
        interval_sec: cfg.RESEARCH_CYCLE_SEC,
        next_at: nextAt(research.rows[0]?.ts, cfg.RESEARCH_CYCLE_SEC * 1000),
      },
      {
        key: 'broadcast',
        label: 'Broadcast',
        last_at: broadcast.rows[0]?.ts ? Number(broadcast.rows[0].ts) : null,
        interval_sec: cfg.BROADCAST_INTERVAL_MIN * 60,
        next_at: nextAt(broadcast.rows[0]?.ts, cfg.BROADCAST_INTERVAL_MIN * 60_000),
      },
      {
        key: 'discovery',
        label: 'Discovery',
        last_at: discovery.rows[0]?.ts ? Number(discovery.rows[0].ts) : null,
        interval_sec: 24 * 60 * 60,
        next_at: nextAt(discovery.rows[0]?.ts, 24 * 60 * 60_000),
      },
    ]

    return NextResponse.json({ loops, now: Date.now() })
  } finally { db.release() }
}

function nextAt(lastTs: unknown, intervalMs: number): number | null {
  if (!lastTs) return null
  return Number(lastTs) + intervalMs
}
