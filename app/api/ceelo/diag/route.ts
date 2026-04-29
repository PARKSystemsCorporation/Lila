import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import * as Espn from '@/lib/ceelo/espn'
import * as Odds from '@/lib/ceelo/odds'
import { ALL_SPORTS } from '@/lib/ceelo/teams'

export const dynamic = 'force-dynamic'

// GET /api/ceelo/diag
//
// Live diagnostic: hits ESPN scoreboard + Odds API for each sport and
// returns counts. Lets the operator see exactly what upstream is
// returning when Ceelo says "no live lines" — distinguishes "Odds API
// returning empty" from "lines fetched but team-name match failed" from
// "loop hasn't fired yet".

export async function GET() {
  const sports = ALL_SPORTS
  const startedAt = Date.now()

  const upstream = await Promise.all(sports.map(async sport => {
    // ESPN current/upcoming schedule
    let espnGames = 0
    let espnErr: string | null = null
    try {
      const games = sport === 'NFL'
        ? await Espn.fetchCurrent('NFL')
        : await Espn.fetchUpcoming(sport, 7)
      espnGames = games.length
    } catch (e) {
      espnErr = String(e).slice(0, 120)
    }

    // Odds API
    let oddsLines = 0
    let oddsErr: string | null = null
    let oddsConfigured = Odds.isConfigured()
    if (oddsConfigured) {
      try {
        const lines = await Odds.fetchLines(sport)
        oddsLines = lines.length
      } catch (e) {
        oddsErr = String(e).slice(0, 120)
      }
    }

    return { sport, espn_games: espnGames, espn_err: espnErr, odds_configured: oddsConfigured, odds_lines: oddsLines, odds_err: oddsErr }
  }))

  // DB-side state per sport — what's actually persisted now.
  let dbState: Array<Record<string, unknown>> = []
  if (process.env.DATABASE_URL) {
    const pool = getPool()
    const db = await pool.connect()
    try {
      await ensureSchema(db)
      const { rows } = await db.query(
        `SELECT s.sport,
                (SELECT COUNT(*) FROM ceelo_team_ratings r WHERE r.sport=s.sport AND r.games_played > 0) AS rated_teams,
                (SELECT COUNT(*) FROM ceelo_games g       WHERE g.sport=s.sport AND g.status='scheduled' AND g.kickoff_at > NOW()) AS upcoming_games,
                (SELECT COUNT(*) FROM ceelo_games g       WHERE g.sport=s.sport AND g.status='final')                                AS final_games,
                (SELECT COUNT(*) FROM ceelo_lines l       WHERE l.sport=s.sport AND l.fetched_at > NOW() - INTERVAL '6 hours')        AS lines_recent,
                (SELECT MAX(fetched_at)::text FROM ceelo_lines l WHERE l.sport=s.sport)                                                AS last_lines_at,
                (SELECT COUNT(*) FROM ceelo_model_lines m JOIN ceelo_games g ON g.id=m.game_id WHERE g.sport=s.sport)                  AS model_lines
         FROM (VALUES ('NFL'),('NBA'),('MLB'),('NHL')) AS s(sport)`
      )
      dbState = rows
    } finally { db.release() }
  }

  return NextResponse.json({
    elapsed_ms: Date.now() - startedAt,
    upstream,
    db: dbState,
    notes: [
      'upstream.espn_games = ESPN scoreboard returned this many games right now.',
      'upstream.odds_lines = how many lines the Odds API returned this second (zero is meaningful — could be offseason or no upcoming slate).',
      'db.lines_recent     = how many ceelo_lines rows landed in the last 6h (i.e. the loop has been running and storing).',
      'db.last_lines_at    = the timestamp of the most-recent line row per sport. NULL = none ever.',
    ],
  })
}
