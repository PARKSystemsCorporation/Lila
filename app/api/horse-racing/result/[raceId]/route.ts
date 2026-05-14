import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/horse-racing/result/<raceId>
//   → { data: { result, model_pick, settled }, status, generated_at }
//
// Reads the graded result (ceelo_results) + Ceelo's hypothetical pick
// (ceelo_picks source='model') for a finished race. `settled` is true
// when ceelo_picks.model_outcome is non-null.

interface ResultRow {
  finished_at: string | null
  winner_id: string | null
  winner_sp: string | number | null
  finishers: unknown
}

interface PickRow {
  id: number
  horse_id: string | null
  horse_name: string
  fair_decimal: string | number | null
  book_decimal: string | number | null
  edge_pct: string | number | null
  intensity: number | null
  velocity: string | null
  model_outcome: string | null
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ raceId: string }> },
) {
  const { raceId } = await params
  if (!raceId) {
    return NextResponse.json(
      { data: null, status: { error: 'missing raceId' }, generated_at: Date.now() },
    )
  }
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
    const resultRes = await db.query<ResultRow>(
      `SELECT to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS finished_at,
              winner_id, winner_sp, finishers
       FROM ceelo_results WHERE race_id=$1`,
      [raceId]
    )
    const pickRes = await db.query<PickRow>(
      `SELECT id, horse_id, horse_name, fair_decimal, book_decimal, edge_pct,
              intensity, velocity, model_outcome
       FROM ceelo_picks
       WHERE race_id=$1 AND source='model'
       ORDER BY created_at DESC LIMIT 1`,
      [raceId]
    )
    const result = resultRes.rows[0] ?? null
    const pick = pickRes.rows[0] ?? null
    return NextResponse.json({
      data: {
        result,
        model_pick: pick,
        settled: pick != null && pick.model_outcome != null,
      },
      status: { db: true },
      generated_at: Date.now(),
    })
  } catch (e) {
    console.warn('[api/horse-racing/result/[raceId]] error:', e)
    return NextResponse.json({
      data: null,
      status: { db: true, error: String(e).slice(0, 120) },
      generated_at: Date.now(),
    })
  } finally {
    db.release()
  }
}
