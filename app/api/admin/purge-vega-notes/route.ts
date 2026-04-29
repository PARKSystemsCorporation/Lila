import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'

// POST /api/admin/purge-vega-notes
//
// Wipes recent Vega research / scan / feed notes plus Lila's recent
// trade-plan files. Use this once after a prompt revision so the trade
// cycle stops reading day-old notes that reflect the old prompting.
//
// Operator-gated by middleware. Optional ?days=N (default 7) sets the
// lookback. ?dryRun=1 just reports counts without deleting.

export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'no db' }, { status: 503 })
  }
  const url = new URL(req.url)
  const days = Math.max(1, Math.min(60, Number(url.searchParams.get('days') ?? '7')))
  const dryRun = url.searchParams.get('dryRun') === '1'

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    // Targets:
    //   analyst/notes/feed-*       — T1 headline summaries
    //   analyst/notes/scan-*       — T2 market-scan verdicts
    //   analyst/notes/research-*   — T3 watchlist notes
    //   analyst/summaries/*        — M0 maintenance summaries
    //   lila/plans/*               — Lila's per-cycle trade plans
    const patterns = [
      'analyst/notes/feed-%',
      'analyst/notes/scan-%',
      'analyst/notes/research-%',
      'analyst/summaries/%',
      'lila/plans/%',
    ]

    const counts: Record<string, number> = {}
    for (const p of patterns) {
      if (dryRun) {
        const { rows: [r] } = await db.query(
          `SELECT COUNT(*) AS n FROM analyst_notes
            WHERE path LIKE $1 AND updated_at > NOW() - ($2 || ' days')::interval`,
          [p, days]
        )
        counts[p] = Number(r?.n ?? 0)
      } else {
        const res = await db.query(
          `DELETE FROM analyst_notes
            WHERE path LIKE $1 AND updated_at > NOW() - ($2 || ' days')::interval`,
          [p, days]
        )
        counts[p] = res.rowCount ?? 0
      }
    }

    const total = Object.values(counts).reduce((a, b) => a + b, 0)

    if (!dryRun) {
      await db.query(
        `INSERT INTO lila_log (message, type) VALUES ($1, $2)`,
        [`Admin purge: ${total} stale Vega/Lila notes wiped (last ${days}d).`, 'info']
      )
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      days,
      total,
      counts,
    })
  } finally {
    db.release()
  }
}
