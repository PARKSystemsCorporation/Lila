import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/picks/edges?sport=NFL|NBA|MLB&days=7
//
// Returns ONLY upcoming games where Ceelo's model spread differs from
// the latest market book line by at least the sport's edge threshold.
// One row per (game × book) so the operator can see line shopping
// across draftkings / fanduel / etc.
//
// Response shape mirrors the FanDuel / sports-app scoreboard layout:
//   game (matchup label), records, lines, open, model spread, model
//   home prob, edge in points, confidence, public bets%, public money%.

const EDGE_PT_BY_SPORT: Record<string, number> = {
  NFL: 1.0,
  NBA: 1.5,
  MLB: 0.5,
}

interface EdgeRow {
  game_id: number
  sport: string
  game_label: string                // "AWAY @ HOME"
  kickoff_at: number                // ms epoch
  home_team: string
  away_team: string
  home_record: string               // "1-2" — current-season W-L computed from graded games
  away_record: string
  market_home_spread: number        // book line, home-side
  open_home_spread: number | null   // first book line we saw (or NULL until tracked)
  book: string
  model_home_spread: number         // Ceelo's model spread
  model_home_prob: number           // 0..1
  edge_points: number               // signed: positive = take HOME, negative = take AWAY
  edge_threshold: number
  confidence: 'low' | 'medium' | 'high'
  pick_side: 'home' | 'away'
  public_bets_pct: number | null
  public_money_pct: number | null
  public_side: string | null        // 'home' | 'away'
}

export async function GET(req: Request) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ edges: [], byDate: [] })
  }

  const url = new URL(req.url)
  const sport = (url.searchParams.get('sport') ?? 'NFL').toUpperCase()
  const days = Math.max(1, Math.min(14, parseInt(url.searchParams.get('days') ?? '7', 10) || 7))

  const pool = getPool()
  const db = await pool.connect()

  try {
    await ensureSchema(db)

    // Pull every upcoming game in the sport with both a book line and a
    // model line. Edge filter happens client-side here (not in SQL) so
    // we can also surface near-edge games dimmed if we ever want to.
    const { rows } = await db.query(
      `WITH latest_lines AS (
         SELECT DISTINCT ON (game_id, book)
                game_id, book, home_line, public_bets_pct, public_money_pct, public_side, fetched_at,
                FIRST_VALUE(home_line) OVER (PARTITION BY game_id, book ORDER BY fetched_at ASC) AS open_home_line
         FROM ceelo_lines
         WHERE market='spread' AND home_line IS NOT NULL
         ORDER BY game_id, book, fetched_at DESC
       )
       SELECT g.id AS game_id, g.sport, g.home_team, g.away_team, g.kickoff_at,
              m.model_spread, m.model_home_prob,
              l.book, l.home_line AS book_spread, l.open_home_line,
              l.public_bets_pct, l.public_money_pct, l.public_side
       FROM ceelo_games g
       JOIN ceelo_model_lines m ON m.game_id = g.id
       JOIN latest_lines l      ON l.game_id = g.id
       WHERE g.sport = $1
         AND g.status = 'scheduled'
         AND g.kickoff_at > NOW() - INTERVAL '15 minutes'
         AND g.kickoff_at < NOW() + ($2 || ' days')::interval
       ORDER BY g.kickoff_at ASC, g.id, l.book`,
      [sport, days]
    )

    // Compute per-team current-season records once.
    const recordRes = await db.query(
      `SELECT season,
              CASE WHEN home_score > away_score THEN home_team ELSE away_team END AS winner,
              CASE WHEN home_score > away_score THEN away_team ELSE home_team END AS loser
       FROM ceelo_games
       WHERE sport = $1 AND status = 'final'
         AND home_score IS NOT NULL AND away_score IS NOT NULL`,
      [sport]
    )
    const wlMap = new Map<string, { w: number; l: number }>()
    let latestSeason = 0
    for (const r of recordRes.rows) {
      const season = Number(r.season)
      if (season > latestSeason) latestSeason = season
    }
    for (const r of recordRes.rows) {
      if (Number(r.season) !== latestSeason) continue
      const w = wlMap.get(r.winner) ?? { w: 0, l: 0 }
      w.w++; wlMap.set(r.winner, w)
      const l = wlMap.get(r.loser) ?? { w: 0, l: 0 }
      l.l++; wlMap.set(r.loser, l)
    }
    const recordOf = (team: string) => {
      const x = wlMap.get(team)
      return x ? `${x.w}-${x.l}` : '0-0'
    }

    const threshold = EDGE_PT_BY_SPORT[sport] ?? 1.0

    const edges: EdgeRow[] = []
    for (const r of rows) {
      const model = Number(r.model_spread)
      const book  = Number(r.book_spread)
      const edge  = +(book - model).toFixed(2)
      if (Math.abs(edge) < threshold) continue

      const pickSide: 'home' | 'away' = edge > 0 ? 'home' : 'away'
      const conf =
        Math.abs(edge) >= 2.5 * threshold ? 'high'
      : Math.abs(edge) >= 1.5 * threshold ? 'medium'
      : 'low'

      edges.push({
        game_id: Number(r.game_id),
        sport: r.sport,
        game_label: `${r.away_team} @ ${r.home_team}`,
        kickoff_at: r.kickoff_at ? new Date(r.kickoff_at).getTime() : 0,
        home_team: r.home_team,
        away_team: r.away_team,
        home_record: recordOf(r.home_team),
        away_record: recordOf(r.away_team),
        market_home_spread: book,
        open_home_spread: r.open_home_line != null ? Number(r.open_home_line) : null,
        book: r.book,
        model_home_spread: model,
        model_home_prob: Number(r.model_home_prob),
        edge_points: edge,
        edge_threshold: threshold,
        confidence: conf,
        pick_side: pickSide,
        public_bets_pct:  r.public_bets_pct  != null ? Number(r.public_bets_pct)  : null,
        public_money_pct: r.public_money_pct != null ? Number(r.public_money_pct) : null,
        public_side:      r.public_side ?? null,
      })
    }

    // Group edges by date for the FanDuel-style date-grouped UI.
    const byDate: Record<string, EdgeRow[]> = {}
    for (const e of edges) {
      const d = new Date(e.kickoff_at).toISOString().slice(0, 10)
      ;(byDate[d] ??= []).push(e)
    }
    const byDateArr = Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, items]) => ({ date, items }))

    // Per-sport meta so the UI can render thresholds + counts.
    const meta = {
      sport,
      threshold,
      total_games: rows.length,
      edge_count:  edges.length,
      latest_season: latestSeason,
    }

    return NextResponse.json({ edges, byDate: byDateArr, meta })
  } finally {
    db.release()
  }
}
