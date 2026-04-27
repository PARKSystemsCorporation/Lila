import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import * as Nflverse from '@/lib/ceelo/nflverse'
import * as Pbp from '@/lib/ceelo/pbp'
import { applyGame, DEFAULT_RATING } from '@/lib/ceelo/ratings'

export const dynamic = 'force-dynamic'

// POST /api/ceelo/seed?seasons=3
//   Pulls the last N completed regular + post seasons from nflverse,
//   inserts each game into ceelo_games (with closing spread/total when
//   known), and Elo-walks the completed games to seed ceelo_team_ratings.
//
//   Idempotent: marks ceelo_backfill rows per season so re-runs are
//   inexpensive (we skip seasons already graded). Pass ?force=1 to redo.

export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'no db' }, { status: 503 })
  }

  const url = new URL(req.url)
  const N = Math.max(1, Math.min(10, parseInt(url.searchParams.get('seasons') ?? '3', 10) || 3))
  const force = url.searchParams.get('force') === '1'

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    // Decide which seasons to walk. Use the LATEST season that has any
    // completed games, then go back N from there. Today's season may
    // already be in progress — that's OK, we ingest unfinished games as
    // 'scheduled' but only Elo-walk completed ones.
    const all = await Nflverse.fetchAllGames()
    if (!all.length) {
      return NextResponse.json({ error: 'nflverse fetch returned no rows' }, { status: 502 })
    }

    const latestSeasonWithFinals = all
      .filter(g => g.completed)
      .reduce((m, g) => Math.max(m, g.season), 0)
    if (!latestSeasonWithFinals) {
      return NextResponse.json({ error: 'no completed games found in nflverse data' }, { status: 502 })
    }

    const seasons: number[] = []
    for (let s = latestSeasonWithFinals - N + 1; s <= latestSeasonWithFinals; s++) seasons.push(s)

    // Skip already-seeded seasons unless force=1.
    const { rows: doneRows } = await db.query(`SELECT season FROM ceelo_backfill`)
    const done = new Set<number>(doneRows.map((r: { season: number }) => Number(r.season)))
    const todo = force ? seasons : seasons.filter(s => !done.has(s))

    if (todo.length === 0) {
      return NextResponse.json({
        ok: true,
        skipped: 'all requested seasons already seeded; pass &force=1 to redo',
        seasons,
      })
    }

    // Wipe ratings + relevant games when forcing — otherwise we'd double-walk.
    if (force) {
      await db.query(`DELETE FROM ceelo_team_ratings`)
      await db.query(
        `DELETE FROM ceelo_games WHERE season = ANY($1::int[])`,
        [seasons]
      )
      await db.query(
        `DELETE FROM ceelo_backfill WHERE season = ANY($1::int[])`,
        [seasons]
      )
    }

    let totalIngested = 0
    let totalGraded = 0
    let totalEpaTeams = 0
    const epaErrors: string[] = []

    for (const season of todo) {
      const seasonGames = all
        .filter(g => g.season === season)
        .sort((a, b) => (a.gameday || '').localeCompare(b.gameday || ''))

      // 1. Upsert all games (scheduled + completed). Use a 'nflverse:'
      //    prefix on espn_id so backfill rows don't collide with the live
      //    ESPN scoreboard ingest (which uses ESPN's numeric id).
      for (const g of seasonGames) {
        const espn_id = `nflverse:${g.game_id}`
        const status = g.completed ? 'final' : 'scheduled'
        // game_type → season_type (REG=2, postseason WC/DIV/CON/SB=3, preseason=1)
        const season_type = g.game_type === 'PRE' ? 1 : (g.game_type === 'REG' ? 2 : 3)
        await db.query(
          `INSERT INTO ceelo_games
             (espn_id, season, week, season_type, home_team, away_team,
              kickoff_at, status, home_score, away_score, neutral_site,
              closing_spread, closing_total, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,FALSE,$11,$12,NOW())
           ON CONFLICT (espn_id) DO UPDATE
             SET status=EXCLUDED.status,
                 home_score=EXCLUDED.home_score,
                 away_score=EXCLUDED.away_score,
                 closing_spread=EXCLUDED.closing_spread,
                 closing_total=EXCLUDED.closing_total,
                 updated_at=NOW()`,
          [
            espn_id, g.season, g.week, season_type,
            g.home_team, g.away_team,
            g.gameday ? `${g.gameday}T17:00:00Z` : null,
            status, g.home_score, g.away_score,
            g.spread_line, g.total_line,
          ]
        )
        totalIngested++

        // 2. Elo-walk completed regular + postseason games (skip preseason).
        if (g.completed && season_type !== 1) {
          const homeR = await getRating(db, g.home_team)
          const awayR = await getRating(db, g.away_team)
          const upd = applyGame({
            homeRating: homeR,
            awayRating: awayR,
            homeScore: g.home_score!,
            awayScore: g.away_score!,
          })
          await upsertRating(db, g.home_team, upd.homeNew, g.gameday)
          await upsertRating(db, g.away_team, upd.awayNew, g.gameday)
          await db.query(
            `UPDATE ceelo_games SET graded_at=NOW(), updated_at=NOW() WHERE espn_id=$1`,
            [espn_id]
          )
          totalGraded++
        }
      }

      // 3. Mark season as seeded.
      await db.query(
        `INSERT INTO ceelo_backfill (season, games_in)
         VALUES ($1, $2)
         ON CONFLICT (season) DO UPDATE
           SET games_in=EXCLUDED.games_in, graded_at=NOW()`,
        [season, seasonGames.length]
      )

      // 4. Compute EPA aggregates from nflverse play-by-play. Skip silently
      //    if the fetch fails (some seasons may not be released yet, and
      //    Elo + closing lines are still useful without EPA).
      try {
        const aggs = await Pbp.fetchSeasonAggregates(season)
        for (const a of aggs) {
          await db.query(
            `INSERT INTO ceelo_team_epa
               (team, season, epa_per_play, pass_epa, rush_epa, success_rate, plays_offense,
                epa_allowed, pass_epa_allowed, rush_epa_allowed, success_allowed, plays_defense,
                net_epa, computed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
             ON CONFLICT (team, season) DO UPDATE
               SET epa_per_play=EXCLUDED.epa_per_play,
                   pass_epa=EXCLUDED.pass_epa,
                   rush_epa=EXCLUDED.rush_epa,
                   success_rate=EXCLUDED.success_rate,
                   plays_offense=EXCLUDED.plays_offense,
                   epa_allowed=EXCLUDED.epa_allowed,
                   pass_epa_allowed=EXCLUDED.pass_epa_allowed,
                   rush_epa_allowed=EXCLUDED.rush_epa_allowed,
                   success_allowed=EXCLUDED.success_allowed,
                   plays_defense=EXCLUDED.plays_defense,
                   net_epa=EXCLUDED.net_epa,
                   computed_at=NOW()`,
            [
              a.team, a.season, a.epa_per_play, a.pass_epa, a.rush_epa, a.success_rate, a.plays_offense,
              a.epa_allowed, a.pass_epa_allowed, a.rush_epa_allowed, a.success_allowed, a.plays_defense,
              a.net_epa,
            ]
          )
          totalEpaTeams++
        }
      } catch (e) {
        epaErrors.push(`${season}: ${String(e).slice(0, 100)}`)
      }
    }

    await db.query(
      `UPDATE ceelo_state SET last_seed_at=NOW(), last_epa_at=NOW(), updated_at=NOW() WHERE id=1`
    )

    return NextResponse.json({
      ok: true,
      seasons_walked: todo,
      games_ingested: totalIngested,
      games_graded:   totalGraded,
      epa_teams:      totalEpaTeams,
      epa_errors:     epaErrors,
    })
  } finally { db.release() }
}

// GET /api/ceelo/seed → status: which seasons have been seeded, when.
export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ ratedTeams: 0, seasons: [] })
  }
  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const { rows: rated } = await db.query(
      `SELECT COUNT(*) AS n FROM ceelo_team_ratings WHERE games_played > 0`
    )
    const { rows: seasons } = await db.query(
      `SELECT season, games_in,
              (EXTRACT(EPOCH FROM graded_at) * 1000)::bigint AS graded_ts
       FROM ceelo_backfill ORDER BY season DESC`
    )
    const { rows: epa } = await db.query(
      `SELECT season, COUNT(*) AS teams FROM ceelo_team_epa GROUP BY season ORDER BY season DESC`
    )
    return NextResponse.json({
      ratedTeams: Number(rated[0]?.n ?? 0),
      epaSeasons: epa.map((e: { season: number; teams: number }) => ({
        season: Number(e.season),
        teams:  Number(e.teams),
      })),
      seasons: seasons.map((s: { season: number; games_in: number; graded_ts: bigint }) => ({
        season: Number(s.season),
        games_in: Number(s.games_in),
        graded_ts: Number(s.graded_ts),
      })),
    })
  } finally { db.release() }
}

// ── helpers ──────────────────────────────────────────────────────────────

async function getRating(db: import('pg').PoolClient, team: string): Promise<number> {
  const { rows: [r] } = await db.query(
    `SELECT rating FROM ceelo_team_ratings WHERE team=$1`, [team]
  )
  return r ? Number(r.rating) : DEFAULT_RATING
}

async function upsertRating(db: import('pg').PoolClient, team: string, rating: number, lastGameAt: string): Promise<void> {
  const ts = lastGameAt ? `${lastGameAt}T17:00:00Z` : new Date().toISOString()
  await db.query(
    `INSERT INTO ceelo_team_ratings (team, rating, games_played, last_game_at, updated_at)
     VALUES ($1,$2,1,$3,NOW())
     ON CONFLICT (team) DO UPDATE
       SET rating=EXCLUDED.rating,
           games_played=ceelo_team_ratings.games_played + 1,
           last_game_at=GREATEST(ceelo_team_ratings.last_game_at, EXCLUDED.last_game_at),
           updated_at=NOW()`,
    [team, rating, ts]
  )
}
