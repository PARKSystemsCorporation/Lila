import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import * as Espn from '@/lib/ceelo/espn'
import { applyGame, DEFAULT_RATING } from '@/lib/ceelo/ratings'
import { ALL_SPORTS, type Sport } from '@/lib/ceelo/teams'
import type { PoolClient } from 'pg'

export const dynamic = 'force-dynamic'

// POST /api/ceelo/seed-prev?sport=NBA|MLB|NFL|ALL
//
// Walks the most-recently-completed season of the given sport via
// ESPN's scoreboard date range, ingesting each game into ceelo_games
// and Elo-walking the completed ones into ceelo_team_ratings. Use this
// once after deploy so NBA and MLB ratings start with the prior season
// already baked in instead of cold-starting at 1500. NFL has its own
// (richer) seed via /api/ceelo/seed (nflverse historical with closing
// lines + EPA) — using this on NFL is a fallback only.
//
// Idempotent per-game via espn_id ON CONFLICT. Idempotent per-rating
// via the (sport, team) PK on ceelo_team_ratings — but applyGame is
// stateful, so re-running this endpoint stacks Elo deltas on top of
// existing ratings. Pass ?wipe=1 to clear the sport's ratings + games
// first if you want a clean re-seed.

export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'no db' }, { status: 503 })

  const url = new URL(req.url)
  const sportParam = (url.searchParams.get('sport') ?? 'ALL').toUpperCase()
  const wipe = url.searchParams.get('wipe') === '1'

  const targets: Sport[] =
    sportParam === 'ALL'
      ? (ALL_SPORTS.filter(s => s !== 'NFL'))   // NFL has its own seed
      : (ALL_SPORTS.includes(sportParam as Sport) ? [sportParam as Sport] : [])

  if (targets.length === 0) {
    return NextResponse.json({ error: `bad sport: ${sportParam}` }, { status: 400 })
  }

  const pool = getPool()
  const db = await pool.connect()
  const results: Array<{ sport: Sport; label: string; ingested: number; graded: number }> = []
  try {
    await ensureSchema(db)

    for (const sport of targets) {
      const range = Espn.defaultPriorSeasonRange(sport)

      if (wipe) {
        // Clean slate for this sport only — leaves other sports' ratings
        // and the upcoming-season schedule intact.
        await db.query(`DELETE FROM ceelo_team_ratings WHERE sport=$1`, [sport])
        await db.query(
          `DELETE FROM ceelo_games WHERE sport=$1
             AND kickoff_at < NOW() - INTERVAL '7 days'`,
          [sport]
        )
      }

      const games = await Espn.fetchDateRange(sport, range.start, range.end)
      games.sort((a, b) => (a.kickoff_at ?? '').localeCompare(b.kickoff_at ?? ''))

      let ingested = 0
      let graded = 0

      for (const g of games) {
        await db.query(
          `INSERT INTO ceelo_games
             (espn_id, sport, season, week, season_type, home_team, away_team, kickoff_at,
              status, home_score, away_score, neutral_site, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
           ON CONFLICT (espn_id) DO UPDATE
             SET status=EXCLUDED.status,
                 home_score=EXCLUDED.home_score,
                 away_score=EXCLUDED.away_score,
                 sport=EXCLUDED.sport,
                 updated_at=NOW()`,
          [g.espn_id, sport, g.season, g.week, g.season_type,
           g.home_team, g.away_team, g.kickoff_at, g.status,
           g.home_score, g.away_score, g.neutral_site]
        )
        ingested++

        // Elo-walk only completed games (regular + postseason), skipping
        // anything already graded (so this is safe to run incrementally).
        if (g.status === 'final' && g.home_score != null && g.away_score != null) {
          const { rows: [graded_at] } = await db.query(
            `SELECT graded_at FROM ceelo_games WHERE espn_id=$1`,
            [g.espn_id]
          )
          if (graded_at?.graded_at && !wipe) continue   // already walked

          const homeR = await getRating(db, sport, g.home_team)
          const awayR = await getRating(db, sport, g.away_team)
          const upd = applyGame({
            homeRating: homeR,
            awayRating: awayR,
            homeScore: g.home_score,
            awayScore: g.away_score,
            neutralSite: Boolean(g.neutral_site),
            sport,
          })
          await upsertRating(db, sport, g.home_team, upd.homeNew, g.kickoff_at)
          await upsertRating(db, sport, g.away_team, upd.awayNew, g.kickoff_at)
          await db.query(
            `UPDATE ceelo_games SET graded_at=NOW(), updated_at=NOW() WHERE espn_id=$1`,
            [g.espn_id]
          )
          graded++
        }
      }

      results.push({ sport, label: range.label, ingested, graded })
    }

    await db.query(`UPDATE ceelo_state SET last_seed_at=NOW(), updated_at=NOW() WHERE id=1`)
    return NextResponse.json({ ok: true, results })
  } finally {
    db.release()
  }
}

// GET — surface what's been seeded per sport so the UI can render
// "NBA: 2024-25 seeded · 30/30 rated" or similar.
export async function GET() {
  if (!process.env.DATABASE_URL) return NextResponse.json({ sports: [] })
  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const { rows } = await db.query(
      `SELECT sport, COUNT(*) AS rated_teams, MAX(last_game_at) AS most_recent_game
       FROM ceelo_team_ratings
       WHERE games_played > 0
       GROUP BY sport
       ORDER BY sport`
    )
    return NextResponse.json({
      sports: rows.map((r: { sport: string; rated_teams: number; most_recent_game: string | null }) => ({
        sport: r.sport,
        rated_teams: Number(r.rated_teams),
        most_recent_game: r.most_recent_game,
      })),
    })
  } finally { db.release() }
}

// ── helpers ──────────────────────────────────────────────────────────────

async function getRating(db: PoolClient, sport: Sport, team: string): Promise<number> {
  const { rows: [r] } = await db.query(
    `SELECT rating FROM ceelo_team_ratings WHERE sport=$1 AND team=$2`,
    [sport, team]
  )
  return r ? Number(r.rating) : DEFAULT_RATING
}

async function upsertRating(db: PoolClient, sport: Sport, team: string, rating: number, lastGameAt: string): Promise<void> {
  await db.query(
    `INSERT INTO ceelo_team_ratings (sport, team, rating, games_played, last_game_at, updated_at)
     VALUES ($1,$2,$3,1,$4,NOW())
     ON CONFLICT (sport, team) DO UPDATE
       SET rating=EXCLUDED.rating,
           games_played=ceelo_team_ratings.games_played + 1,
           last_game_at=GREATEST(ceelo_team_ratings.last_game_at, EXCLUDED.last_game_at),
           updated_at=NOW()`,
    [sport, team, rating, lastGameAt]
  )
}
