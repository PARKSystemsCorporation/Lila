import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { getHorseDataService } from '@/lib/horse-racing/data-service'
import { calculateYield } from '@/lib/horse-racing/yield'
import { liveSources } from '@/lib/horse-racing/sources'

export const dynamic = 'force-dynamic'

// GET /api/horse-racing/<raceId>
//   → { data: { race, oddsHistory: Record<horse_id, [{t,decimal,fair,edge}]>, signal },
//       status, generated_at }
//
// Drill-in detail. Hydrates the race from our DB first (so seeded
// fixtures work without upstream creds), falls back to the live Racing
// API. Odds history comes from ceelo_runner_odds — every snapshot the
// C2 phase has collected.

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

  const svc = getHorseDataService()

  if (!process.env.DATABASE_URL) {
    // No DB — try upstream directly and skip history.
    try {
      const race = await svc.getRacecard(raceId)
      const signal = race ? calculateYield(race) : null
      return NextResponse.json({
        data: race ? { race, oddsHistory: {}, signal } : null,
        status: {
          ...svc.status(),
          live_sources: liveSources().map(s => ({ name: s.name, kind: s.kind })),
          db: false,
        },
        generated_at: Date.now(),
      })
    } catch (e) {
      return NextResponse.json({
        data: null,
        status: {
          ...svc.status(),
          db: false,
          error: String(e).slice(0, 120),
        },
        generated_at: Date.now(),
      })
    }
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    let race = await svc.getRacecardFromDb(db, raceId)
    if (!race) {
      // Fallback to live Racing API. If creds are missing this returns
      // null and the response carries an empty data payload, which is
      // the documented behavior.
      race = await svc.getRacecard(raceId).catch(() => null)
    }
    if (!race) {
      return NextResponse.json({
        data: null,
        status: {
          ...svc.status(),
          live_sources: liveSources().map(s => ({ name: s.name, kind: s.kind })),
          db: true,
        },
        generated_at: Date.now(),
      })
    }
    const oddsHistory = await svc.getOddsHistory(db, raceId).catch(() => ({}))
    const signal = calculateYield(race)
    return NextResponse.json({
      data: { race, oddsHistory, signal },
      status: {
        ...svc.status(),
        live_sources: liveSources().map(s => ({ name: s.name, kind: s.kind })),
        db: true,
      },
      generated_at: Date.now(),
    })
  } catch (e) {
    console.warn('[api/horse-racing/[raceId]] error:', e)
    return NextResponse.json({
      data: null,
      status: {
        ...svc.status(),
        db: true,
        error: String(e).slice(0, 120),
      },
      generated_at: Date.now(),
    })
  } finally {
    db.release()
  }
}
