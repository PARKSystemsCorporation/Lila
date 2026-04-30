import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const SPORTS = ['NFL', 'NBA', 'NHL', 'MLB'] as const
type Sport = typeof SPORTS[number]

interface WeekPoint {
  w: number
  edge_points: number
  n_picks: number
}

interface SportSeries {
  sport: Sport
  weeks: WeekPoint[]
  total_edge: number
  total_picks: number
  wins: number
  losses: number
  pushes: number
}

function emptySeries(sport: Sport): SportSeries {
  return { sport, weeks: [], total_edge: 0, total_picks: 0, wins: 0, losses: 0, pushes: 0 }
}

function emptyPayload() {
  const sports: Record<Sport, SportSeries> = {
    NFL: emptySeries('NFL'),
    NBA: emptySeries('NBA'),
    NHL: emptySeries('NHL'),
    MLB: emptySeries('MLB'),
  }
  return NextResponse.json({ year: 2025, sports, refreshed_ts: Date.now() })
}

export async function GET() {
  if (!process.env.DATABASE_URL) return emptyPayload()

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const res = await db.query(
      `SELECT
         sport,
         EXTRACT(WEEK FROM COALESCE(settled_at, created_at))::int AS wk,
         SUM(COALESCE(edge_points, 0))::float                     AS edge_pts,
         COUNT(*)::int                                            AS n_picks,
         SUM(CASE WHEN status = 'won'  THEN 1 ELSE 0 END)::int    AS wins,
         SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END)::int    AS losses,
         SUM(CASE WHEN status = 'push' THEN 1 ELSE 0 END)::int    AS pushes
       FROM ceelo_picks
       WHERE EXTRACT(YEAR FROM COALESCE(settled_at, created_at)) = 2025
         AND status IN ('won', 'lost', 'push', 'taken', 'skipped', 'open')
       GROUP BY sport, wk
       ORDER BY sport, wk`,
    )

    const sports: Record<Sport, SportSeries> = {
      NFL: emptySeries('NFL'),
      NBA: emptySeries('NBA'),
      NHL: emptySeries('NHL'),
      MLB: emptySeries('MLB'),
    }

    for (const row of res.rows) {
      const sport = String(row.sport ?? '').toUpperCase() as Sport
      if (!sports[sport]) continue
      const wk = Number(row.wk)
      const edge = Number(row.edge_pts) || 0
      const n = Number(row.n_picks) || 0
      sports[sport].weeks.push({ w: wk, edge_points: +edge.toFixed(2), n_picks: n })
      sports[sport].total_edge += edge
      sports[sport].total_picks += n
      sports[sport].wins += Number(row.wins) || 0
      sports[sport].losses += Number(row.losses) || 0
      sports[sport].pushes += Number(row.pushes) || 0
    }

    for (const s of SPORTS) {
      sports[s].total_edge = +sports[s].total_edge.toFixed(2)
    }

    return NextResponse.json({ year: 2025, sports, refreshed_ts: Date.now() })
  } catch {
    return emptyPayload()
  } finally {
    db.release()
  }
}
