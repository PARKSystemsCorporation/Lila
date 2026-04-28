import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Read-only viewer edges feed. Mirrors the operator's /api/picks/edges
// but with only the public-safe columns: matchup, lines, model line,
// edge, predicted scores, traffic-light. No operator-only telemetry.
//
// Auth: gated by the middleware on lila_viewer (or lila_auth) cookie.

const FALLBACK_TOTAL: Record<string, number> = { NFL: 45, NBA: 225, MLB: 9 }
const GREEN_CUTOFF = 1.5

export async function GET(req: Request) {
  if (!process.env.DATABASE_URL) return NextResponse.json({ games: [], byDate: [], meta: null })

  const url = new URL(req.url)
  const sport = (url.searchParams.get('sport') ?? 'NFL').toUpperCase()
  const days  = Math.max(1, Math.min(14, parseInt(url.searchParams.get('days') ?? '7', 10) || 7))

  const greenCutoff = sport === 'MLB' ? 0.75 : GREEN_CUTOFF

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    await db.query(
      `UPDATE viewers SET last_seen_at = NOW() WHERE active = TRUE AND last_seen_at < NOW() - INTERVAL '5 minutes'`
    ).catch(() => { /* lazy stamp */ })

    const { rows: [tot] } = await db.query(
      `SELECT AVG(home_score + away_score) AS avg_total, COUNT(*) AS n
       FROM ceelo_games
       WHERE sport=$1 AND status='final' AND home_score IS NOT NULL AND away_score IS NOT NULL`,
      [sport]
    )
    const avgTotal = (tot?.n && Number(tot.n) >= 20) ? Number(tot.avg_total) : (FALLBACK_TOTAL[sport] ?? 45)

    const { rows: gameRows } = await db.query(
      `SELECT g.id AS game_id, g.sport, g.home_team, g.away_team, g.kickoff_at,
              m.model_spread, m.model_home_prob
       FROM ceelo_games g
       LEFT JOIN ceelo_model_lines m ON m.game_id = g.id
       WHERE g.sport = $1
         AND g.status = 'scheduled'
         AND g.kickoff_at > NOW() - INTERVAL '15 minutes'
         AND g.kickoff_at < NOW() + ($2 || ' days')::interval
       ORDER BY g.kickoff_at ASC`,
      [sport, days]
    )

    if (gameRows.length === 0) {
      return NextResponse.json({
        games: [], byDate: [],
        meta: { sport, threshold: greenCutoff, total_games: 0, green_count: 0, yellow_count: 0, avg_total: +avgTotal.toFixed(1) },
      })
    }

    const gameIds = gameRows.map(r => Number(r.game_id))

    const { rows: lineRows } = await db.query(
      `WITH latest AS (
         SELECT DISTINCT ON (game_id, book)
                game_id, book, home_line, fetched_at,
                FIRST_VALUE(home_line) OVER (PARTITION BY game_id, book ORDER BY fetched_at ASC) AS open_home_line
         FROM ceelo_lines
         WHERE market = 'spread' AND home_line IS NOT NULL
           AND game_id = ANY($1::int[])
         ORDER BY game_id, book, fetched_at DESC
       )
       SELECT * FROM latest`,
      [gameIds]
    )
    const linesByGame = new Map<number, typeof lineRows>()
    for (const r of lineRows) {
      const id = Number(r.game_id)
      if (!linesByGame.has(id)) linesByGame.set(id, [])
      linesByGame.get(id)!.push(r)
    }

    // Records
    const { rows: recordRows } = await db.query(
      `SELECT season,
              CASE WHEN home_score > away_score THEN home_team ELSE away_team END AS winner,
              CASE WHEN home_score > away_score THEN away_team ELSE home_team END AS loser
       FROM ceelo_games
       WHERE sport=$1 AND status='final' AND home_score IS NOT NULL AND away_score IS NOT NULL`,
      [sport]
    )
    let latestSeason = 0
    for (const r of recordRows) latestSeason = Math.max(latestSeason, Number(r.season))
    const wlMap = new Map<string, { w: number; l: number }>()
    for (const r of recordRows) {
      if (Number(r.season) !== latestSeason) continue
      const w = wlMap.get(r.winner) ?? { w: 0, l: 0 }; w.w++; wlMap.set(r.winner, w)
      const l = wlMap.get(r.loser)  ?? { w: 0, l: 0 }; l.l++; wlMap.set(r.loser, l)
    }
    const recOf = (t: string) => {
      const x = wlMap.get(t); return x ? `${x.w}-${x.l}` : '0-0'
    }

    const games = gameRows.map(g => {
      const id = Number(g.game_id)
      const bookRows = linesByGame.get(id) ?? []
      const lines = bookRows.map(b => Number(b.home_line))
      const consensus = lines.length ? +(lines.reduce((s, x) => s + x, 0) / lines.length).toFixed(2) : null
      const open = bookRows.length && bookRows[0].open_home_line != null ? Number(bookRows[0].open_home_line) : null

      const model = g.model_spread != null ? Number(g.model_spread) : null
      const modelProb = g.model_home_prob != null ? Number(g.model_home_prob) : null

      let predHome: number | null = null
      let predAway: number | null = null
      if (model != null) {
        predHome = Math.round((avgTotal - model) / 2)
        predAway = Math.round((avgTotal + model) / 2)
      }

      let edge: number | null = null
      let edgeTeam: string | null = null
      if (consensus != null && model != null) {
        edge = +(consensus - model).toFixed(2)
        edgeTeam = edge >= 0 ? g.home_team : g.away_team
      }

      const light: 'green' | 'yellow' | 'grey' =
        edge == null ? 'grey'
      : Math.abs(edge) > greenCutoff ? 'green'
      : 'yellow'

      return {
        game_id: id,
        sport: g.sport,
        home_team: g.home_team,
        away_team: g.away_team,
        home_record: recOf(g.home_team),
        away_record: recOf(g.away_team),
        kickoff_at: g.kickoff_at ? new Date(g.kickoff_at).getTime() : 0,
        consensus_home_spread: consensus,
        open_home_spread: open,
        book_count: bookRows.length,
        model_home_spread: model,
        model_home_prob: modelProb,
        predicted_home_score: predHome,
        predicted_away_score: predAway,
        edge_points: edge,
        edge_team: edgeTeam,
        light,
      }
    })

    games.sort((a, b) => a.kickoff_at - b.kickoff_at)

    const byDate: Record<string, typeof games> = {}
    for (const g of games) {
      const d = new Date(g.kickoff_at).toISOString().slice(0, 10)
      ;(byDate[d] ??= []).push(g)
    }
    const byDateArr = Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, items]) => ({ date, items }))

    return NextResponse.json({
      games,
      byDate: byDateArr,
      meta: {
        sport,
        threshold: greenCutoff,
        total_games: games.length,
        green_count:  games.filter(g => g.light === 'green').length,
        yellow_count: games.filter(g => g.light === 'yellow').length,
        avg_total: +avgTotal.toFixed(1),
      },
    })
  } finally { db.release() }
}
