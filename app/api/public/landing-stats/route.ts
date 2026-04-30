import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface LandingStats {
  articles: number
  picks_open: number
  picks_settled: number
  edges_open: number
  trades_closed: number
  bounties_paid_usd: number
  bounties_paid_count: number
  refreshed_ts: number
}

const ZERO: LandingStats = {
  articles: 0,
  picks_open: 0,
  picks_settled: 0,
  edges_open: 0,
  trades_closed: 0,
  bounties_paid_usd: 0,
  bounties_paid_count: 0,
  refreshed_ts: 0,
}

// All counts are real, even when small. No demo padding — empty deploys
// surface honest zeros until the agents fill the tables.
export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ ...ZERO, refreshed_ts: Date.now() })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const [articles, edgesOpen, picksSettled, tradesClosed, bountiesPaid] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS n FROM articles WHERE status='published'`),
      db.query(`SELECT COUNT(*)::int AS n FROM ceelo_picks WHERE status='open'`),
      db.query(`SELECT COUNT(*)::int AS n FROM ceelo_picks WHERE status IN ('won','lost','push','void')`),
      db.query(`SELECT COUNT(*)::int AS n FROM lila_positions WHERE status='closed'`),
      db.query(
        `SELECT COUNT(*)::int        AS n,
                COALESCE(SUM(payout),0)::float AS usd
           FROM security_reports
          WHERE status='paid'`,
      ),
    ])

    const stats: LandingStats = {
      articles:            articles.rows[0]?.n ?? 0,
      picks_open:          edgesOpen.rows[0]?.n ?? 0,
      picks_settled:       picksSettled.rows[0]?.n ?? 0,
      edges_open:          edgesOpen.rows[0]?.n ?? 0,
      trades_closed:       tradesClosed.rows[0]?.n ?? 0,
      bounties_paid_count: bountiesPaid.rows[0]?.n ?? 0,
      bounties_paid_usd:   Number(bountiesPaid.rows[0]?.usd ?? 0),
      refreshed_ts:        Date.now(),
    }
    return NextResponse.json(stats)
  } catch {
    return NextResponse.json({ ...ZERO, refreshed_ts: Date.now() })
  } finally {
    db.release()
  }
}
