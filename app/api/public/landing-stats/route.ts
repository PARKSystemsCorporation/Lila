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

// 30-second in-memory cache. The landing ticker polls every 60s per
// visitor; without this, a small traffic spike fans out 5×N COUNT(*)
// queries to Postgres. Single-instance memory is fine here — Railway
// runs us as one process; if we ever scale out the cache TTL keeps the
// blast radius bounded regardless.
const CACHE_TTL_MS = 30_000
let cache: { stats: LandingStats; until: number } | null = null
let inflight: Promise<LandingStats> | null = null

// All counts are real, even when small. No demo padding — empty deploys
// surface honest zeros until the agents fill the tables.
export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ ...ZERO, refreshed_ts: Date.now() })
  }

  const now = Date.now()
  if (cache && cache.until > now) {
    return NextResponse.json(cache.stats)
  }
  if (inflight) {
    const stats = await inflight
    return NextResponse.json(stats)
  }

  inflight = computeStats().finally(() => { inflight = null })
  const stats = await inflight
  cache = { stats, until: Date.now() + CACHE_TTL_MS }
  return NextResponse.json(stats)
}

async function computeStats(): Promise<LandingStats> {
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
    return stats
  } catch {
    return { ...ZERO, refreshed_ts: Date.now() }
  } finally {
    db.release()
  }
}
