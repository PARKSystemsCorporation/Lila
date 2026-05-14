import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/ceelo/kpis
//   → { data: {
//         cycle, last_run_at, last_phase_errors, last_phase_at,
//         model_record: { wins, losses, push, roi_pct },
//         open_picks, races_24h, odds_snapshots_24h,
//         edge_series: [{ t, avg_edge, picks }]
//       },
//       status, generated_at }
//
// Powers the operator dashboard's Ceelo card-section. Read-only,
// safe to hit on a tight poll. The edge_series is hourly bucketed for
// the last 24h so EdgeGraph (lightweight-charts) renders cleanly.

interface KpiRow {
  cycle: number
  last_run_at: string | null
  last_c0_error: string | null
  last_c1_error: string | null
  last_c2_error: string | null
  last_c3_error: string | null
  last_c4_error: string | null
  last_c5_error: string | null
  last_phase_at: Record<string, string> | null
}

interface RecordRow {
  wins: number
  losses: number
  pushes: number
  taken_count: number
  payout_sum: string | number | null
  stake_sum: string | number | null
  open_picks: number
}

interface CountsRow {
  races_24h: number
  odds_snapshots_24h: number
}

interface EdgeBucketRow {
  t: string  // ms epoch text
  avg_edge: string | number | null
  picks: number
}

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({
      data: null,
      status: { db: false },
      generated_at: Date.now(),
    })
  }
  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const kpiRes = await db.query<KpiRow>(
      `SELECT cycle,
              to_char(last_run_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_run_at,
              last_c0_error, last_c1_error, last_c2_error,
              last_c3_error, last_c4_error, last_c5_error,
              last_phase_at
       FROM ceelo_state WHERE id=1`
    )
    const recordRes = await db.query<RecordRow>(
      `SELECT
         COUNT(*) FILTER (WHERE status='won')  AS wins,
         COUNT(*) FILTER (WHERE status='lost') AS losses,
         COUNT(*) FILTER (WHERE status='push') AS pushes,
         COUNT(*) FILTER (WHERE status IN ('taken','won','lost','push')) AS taken_count,
         COALESCE(SUM(payout) FILTER (WHERE status IN ('won','lost','push')), 0) AS payout_sum,
         COALESCE(SUM(stake)  FILTER (WHERE status IN ('won','lost','push')), 0) AS stake_sum,
         COUNT(*) FILTER (WHERE status='open') AS open_picks
       FROM ceelo_picks`
    )
    const countsRes = await db.query<CountsRow>(
      `SELECT
         (SELECT COUNT(*) FROM ceelo_races WHERE off_dt >= NOW() - INTERVAL '24 hours') AS races_24h,
         (SELECT COUNT(*) FROM ceelo_runner_odds WHERE fetched_at >= NOW() - INTERVAL '24 hours') AS odds_snapshots_24h`
    )
    const edgeRes = await db.query<EdgeBucketRow>(
      `SELECT (EXTRACT(EPOCH FROM date_trunc('hour', fetched_at)) * 1000)::bigint::text AS t,
              AVG(edge_pct) AS avg_edge,
              COUNT(*) FILTER (WHERE edge_pct > 0) AS picks
       FROM ceelo_runner_odds
       WHERE fetched_at >= NOW() - INTERVAL '24 hours' AND edge_pct IS NOT NULL
       GROUP BY date_trunc('hour', fetched_at)
       ORDER BY date_trunc('hour', fetched_at) ASC`
    )

    const kpi = kpiRes.rows[0]
    const rec = recordRes.rows[0]
    const counts = countsRes.rows[0]

    const payoutSum = numOrZero(rec?.payout_sum)
    const stakeSum  = numOrZero(rec?.stake_sum)
    const roi_pct = stakeSum > 0 ? +((payoutSum / stakeSum) * 100).toFixed(1) : 0

    return NextResponse.json({
      data: {
        cycle: kpi?.cycle ?? 0,
        last_run_at: kpi?.last_run_at ?? null,
        last_phase_errors: kpi ? {
          c0: kpi.last_c0_error,
          c1: kpi.last_c1_error,
          c2: kpi.last_c2_error,
          c3: kpi.last_c3_error,
          c4: kpi.last_c4_error,
          c5: kpi.last_c5_error,
        } : null,
        last_phase_at: kpi?.last_phase_at ?? null,
        model_record: {
          wins: Number(rec?.wins ?? 0),
          losses: Number(rec?.losses ?? 0),
          push: Number(rec?.pushes ?? 0),
          roi_pct,
        },
        open_picks: Number(rec?.open_picks ?? 0),
        races_24h: Number(counts?.races_24h ?? 0),
        odds_snapshots_24h: Number(counts?.odds_snapshots_24h ?? 0),
        edge_series: edgeRes.rows.map(r => ({
          t: Number(r.t),
          avg_edge: numOrZero(r.avg_edge),
          picks: Number(r.picks ?? 0),
        })),
      },
      status: { db: true },
      generated_at: Date.now(),
    })
  } catch (e) {
    console.warn('[api/ceelo/kpis] error:', e)
    return NextResponse.json({
      data: null,
      status: { db: true, error: String(e).slice(0, 120) },
      generated_at: Date.now(),
    })
  } finally {
    db.release()
  }
}

function numOrZero(v: string | number | null | undefined): number {
  if (v == null) return 0
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}
