import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import * as Racing from '@/lib/horse-racing/racing-api'

export const dynamic = 'force-dynamic'

// GET /api/ceelo/diag
//
// Live diagnostic: probes The Racing API and reports row counts from the
// racing-shaped ceelo_* tables. Lets the operator distinguish "no creds set"
// from "creds set but upstream returned 0 meets" from "creds + meets but
// the loop hasn't fetched yet". NA-aware — exposes region + meet count
// + per-country split.

export async function GET() {
  const startedAt = Date.now()

  const region = Racing.getRegion()
  const racingConfigured = Racing.isConfigured()
  let meetsToday = 0
  const meetsTodayByCountry: Record<string, number> = {}
  let racecardsCount = 0
  let racingErr: string | null = null
  if (racingConfigured) {
    try {
      if (region === 'NA') {
        const meets = await Racing.listTodayMeets()
        meetsToday = meets.length
        for (const m of meets) {
          meetsTodayByCountry[m.country] = (meetsTodayByCountry[m.country] ?? 0) + 1
        }
      }
      const cards = await Racing.getTodayRacecards()
      racecardsCount = cards.length
    } catch (e) {
      racingErr = String(e).slice(0, 120)
    }
  }

  let dbState: Record<string, unknown> | null = null
  let phaseHealth: Record<string, unknown> | null = null
  if (process.env.DATABASE_URL) {
    const pool = getPool()
    const db = await pool.connect()
    try {
      await ensureSchema(db)
      const { rows } = await db.query(
        `SELECT
            (SELECT COUNT(*) FROM ceelo_races WHERE status='scheduled' AND off_dt > NOW())             AS upcoming_races,
            (SELECT COUNT(*) FROM ceelo_races WHERE status='final')                                    AS final_races,
            (SELECT COUNT(*) FROM ceelo_runner_odds WHERE fetched_at > NOW() - INTERVAL '6 hours')     AS odds_snapshots_recent,
            (SELECT MAX(fetched_at)::text FROM ceelo_runner_odds)                                      AS last_odds_at,
            (SELECT COUNT(*) FROM ceelo_picks WHERE status='open')                                     AS open_picks,
            (SELECT COUNT(*) FROM ceelo_picks WHERE source='model' AND model_outcome IS NOT NULL)      AS model_graded`
      )
      dbState = rows[0] ?? null

      const { rows: phaseRows } = await db.query(
        `SELECT last_c0_error, last_c1_error, last_c2_error,
                last_c3_error, last_c4_error, last_c5_error,
                last_phase_at,
                to_char(last_run_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_run_at
         FROM ceelo_state WHERE id=1`
      )
      const p = phaseRows[0]
      if (p) {
        phaseHealth = {
          last_run_at: p.last_run_at,
          last_phase_at: p.last_phase_at,
          last_phase_errors: {
            c0: p.last_c0_error,
            c1: p.last_c1_error,
            c2: p.last_c2_error,
            c3: p.last_c3_error,
            c4: p.last_c4_error,
            c5: p.last_c5_error,
          },
        }
      }
    } finally { db.release() }
  }

  return NextResponse.json({
    elapsed_ms: Date.now() - startedAt,
    upstream: {
      racing_configured: racingConfigured,
      region,
      meets_today: meetsToday,
      meets_today_by_country: meetsTodayByCountry,
      racecards: racecardsCount,
      racing_err: racingErr,
    },
    db: dbState,
    phase: phaseHealth,
    notes: [
      'upstream.region                = active Racing API region. NA = North America meets/entries; UK = legacy racecards.',
      'upstream.meets_today           = NA meets returned by the upstream right now (UK = 0 by design).',
      'upstream.meets_today_by_country= per-ISO3 split of those meets (USA/CAN).',
      'upstream.racecards             = total races across all meets, after track allow-list filtering.',
      'db.upcoming_races              = races scheduled in the future and not yet final.',
      'db.odds_snapshots_recent       = per-runner odds rows inserted in the last 6h (loop heartbeat).',
      'db.last_odds_at                = timestamp of the most-recent odds snapshot. NULL = none ever.',
      'phase.last_phase_errors        = last persisted error per c0..c5; NULL when the phase last succeeded.',
      'phase.last_phase_at            = JSONB map { c0: iso, c1: iso, ... } of the last success timestamp.',
    ],
  })
}
