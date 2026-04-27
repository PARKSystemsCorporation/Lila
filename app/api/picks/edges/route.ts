import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/picks/edges?sport=NFL|NBA|MLB&days=7&filter=all|green&sort=time|edge
//
// One row per upcoming game (not per book). Each game carries:
//   - book consensus (avg home_spread across the books that posted),
//     plus best/worst, plus per-book breakdown
//   - Ceelo's revised spread + which side is favored per his model
//   - predicted final scores derived from model_spread + sport-typical
//     total (computed from completed-game averages, with a hardcoded
//     fallback per sport)
//   - traffic-light state: green when |edge| > 1.5, yellow when within
//   - public_bets/money/side when available
//
// Filter: 'green' (default 'all') drops yellow-only rows.
// Sort: 'edge' (default 'time') orders by |edge_points| desc.

const FALLBACK_TOTAL: Record<string, number> = { NFL: 45, NBA: 225, MLB: 9 }
const GREEN_CUTOFF = 1.5  // > 1.5 (or >0.75 runs for MLB) ⇒ green

interface BookLine { book: string; home_line: number }

interface GameRow {
  game_id: number
  sport: string
  home_team: string
  away_team: string
  home_record: string
  away_record: string
  kickoff_at: number
  // Book lines
  books: BookLine[]
  consensus_home_spread: number | null
  best_home_spread: number | null
  worst_home_spread: number | null
  open_home_spread: number | null
  // Model
  model_home_spread: number | null
  model_home_prob: number | null
  // Score predictions
  predicted_home_score: number | null
  predicted_away_score: number | null
  predicted_total: number | null
  // Edge + signal
  edge_points: number | null              // consensus - model (signed)
  edge_side: 'home' | 'away' | null       // which side the edge favors
  edge_team: string | null                // pretty name of edge_side team
  light: 'green' | 'yellow' | 'grey'      // grey = no model or no books
  // Public
  public_bets_pct: number | null
  public_money_pct: number | null
  public_side: 'home' | 'away' | null
}

export async function GET(req: Request) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ games: [], byDate: [], meta: null })
  }

  const url = new URL(req.url)
  const sport = (url.searchParams.get('sport') ?? 'NFL').toUpperCase()
  const days  = Math.max(1, Math.min(14, parseInt(url.searchParams.get('days') ?? '7', 10) || 7))
  const filter = (url.searchParams.get('filter') ?? 'all').toLowerCase() // 'all' | 'green'
  const sort   = (url.searchParams.get('sort')   ?? 'time').toLowerCase()  // 'time' | 'edge'

  const greenCutoff = sport === 'MLB' ? 0.75 : GREEN_CUTOFF

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    // Sport-typical total — average of completed-game totals. Fall back to
    // the hardcoded league constant when we don't have enough data yet.
    const { rows: [tot] } = await db.query(
      `SELECT AVG(home_score + away_score) AS avg_total, COUNT(*) AS n
       FROM ceelo_games
       WHERE sport = $1
         AND status = 'final'
         AND home_score IS NOT NULL AND away_score IS NOT NULL`,
      [sport]
    )
    const avgTotal = (tot?.n && Number(tot.n) >= 20)
      ? Number(tot.avg_total)
      : (FALLBACK_TOTAL[sport] ?? 45)

    // Pull all upcoming games + model line + per-book latest spread.
    // Aggregating across books is done in TypeScript so we keep both the
    // consensus + the full per-book list available.
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
        meta: { sport, threshold: greenCutoff, total_games: 0, green_count: 0, yellow_count: 0,
                avg_total: +avgTotal.toFixed(1) },
      })
    }

    const gameIds = gameRows.map(r => Number(r.game_id))

    // Latest line per (game, book), plus the open line and public % from
    // the most-recent line row per game (any book).
    const { rows: lineRows } = await db.query(
      `WITH latest AS (
         SELECT DISTINCT ON (game_id, book)
                game_id, book, home_line, fetched_at,
                public_bets_pct, public_money_pct, public_side,
                FIRST_VALUE(home_line) OVER (PARTITION BY game_id, book ORDER BY fetched_at ASC) AS open_home_line
         FROM ceelo_lines
         WHERE market = 'spread' AND home_line IS NOT NULL
           AND game_id = ANY($1::int[])
         ORDER BY game_id, book, fetched_at DESC
       )
       SELECT * FROM latest`,
      [gameIds]
    )

    // Group lines per game.
    const linesByGame = new Map<number, typeof lineRows>()
    for (const r of lineRows) {
      const id = Number(r.game_id)
      if (!linesByGame.has(id)) linesByGame.set(id, [])
      linesByGame.get(id)!.push(r)
    }

    // Records (current-season W-L per team).
    const { rows: recordRows } = await db.query(
      `SELECT season,
              CASE WHEN home_score > away_score THEN home_team ELSE away_team END AS winner,
              CASE WHEN home_score > away_score THEN away_team ELSE home_team END AS loser
       FROM ceelo_games
       WHERE sport = $1 AND status = 'final'
         AND home_score IS NOT NULL AND away_score IS NOT NULL`,
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
      const x = wlMap.get(t)
      return x ? `${x.w}-${x.l}` : '0-0'
    }

    // Build the response rows.
    const games: GameRow[] = gameRows.map(g => {
      const id = Number(g.game_id)
      const bookRows = linesByGame.get(id) ?? []
      const books: BookLine[] = bookRows.map(b => ({
        book: String(b.book),
        home_line: Number(b.home_line),
      }))

      const lines = books.map(b => b.home_line)
      const consensus = lines.length ? +(lines.reduce((s, x) => s + x, 0) / lines.length).toFixed(2) : null
      const best  = lines.length ? Math.min(...lines) : null   // most-favorable to home favorite
      const worst = lines.length ? Math.max(...lines) : null
      const open  = bookRows.length && bookRows[0].open_home_line != null ? Number(bookRows[0].open_home_line) : null

      const model = g.model_spread != null ? Number(g.model_spread) : null
      const modelProb = g.model_home_prob != null ? Number(g.model_home_prob) : null

      // Predicted scores from model spread + sport-typical total.
      // home - away = -model_spread; home + away = total.
      let predHome: number | null = null
      let predAway: number | null = null
      let predTotal: number | null = null
      if (model != null) {
        predTotal = +avgTotal.toFixed(0)
        predHome = Math.round((avgTotal - model) / 2)
        predAway = Math.round((avgTotal + model) / 2)
      }

      // Edge: consensus - model. Positive = home undervalued by book ⇒ take home.
      let edge: number | null = null
      let edgeSide: 'home' | 'away' | null = null
      let edgeTeam: string | null = null
      if (consensus != null && model != null) {
        edge = +(consensus - model).toFixed(2)
        edgeSide = edge >= 0 ? 'home' : 'away'
        edgeTeam = edgeSide === 'home' ? g.home_team : g.away_team
      }

      const light: 'green' | 'yellow' | 'grey' =
        edge == null ? 'grey'
      : Math.abs(edge) > greenCutoff ? 'green'
      : 'yellow'

      // Public side (use the most-recent line row that carries % data).
      const withPub = bookRows.find(b => b.public_bets_pct != null) ?? null
      const publicBets  = withPub?.public_bets_pct  != null ? Number(withPub.public_bets_pct)  : null
      const publicMoney = withPub?.public_money_pct != null ? Number(withPub.public_money_pct) : null
      const publicSide  = (withPub?.public_side as 'home' | 'away' | null) ?? null

      return {
        game_id: id,
        sport: g.sport,
        home_team: g.home_team,
        away_team: g.away_team,
        home_record: recOf(g.home_team),
        away_record: recOf(g.away_team),
        kickoff_at: g.kickoff_at ? new Date(g.kickoff_at).getTime() : 0,
        books,
        consensus_home_spread: consensus,
        best_home_spread: best,
        worst_home_spread: worst,
        open_home_spread: open,
        model_home_spread: model,
        model_home_prob: modelProb,
        predicted_home_score: predHome,
        predicted_away_score: predAway,
        predicted_total: predTotal,
        edge_points: edge,
        edge_side: edgeSide,
        edge_team: edgeTeam,
        light,
        public_bets_pct: publicBets,
        public_money_pct: publicMoney,
        public_side: publicSide,
      }
    })

    // Filter
    const filtered = filter === 'green' ? games.filter(g => g.light === 'green') : games

    // Sort
    const sorted = [...filtered]
    if (sort === 'edge') {
      sorted.sort((a, b) => Math.abs(b.edge_points ?? 0) - Math.abs(a.edge_points ?? 0))
    } else {
      sorted.sort((a, b) => a.kickoff_at - b.kickoff_at)
    }

    // Group by date (UTC date for stable bucketing).
    const byDate: Record<string, GameRow[]> = {}
    for (const g of sorted) {
      const d = new Date(g.kickoff_at).toISOString().slice(0, 10)
      ;(byDate[d] ??= []).push(g)
    }
    const byDateArr = Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, items]) => ({ date, items }))

    const greenCount  = games.filter(g => g.light === 'green').length
    const yellowCount = games.filter(g => g.light === 'yellow').length

    return NextResponse.json({
      games: sorted,
      byDate: byDateArr,
      meta: {
        sport,
        threshold: greenCutoff,
        total_games: games.length,
        green_count: greenCount,
        yellow_count: yellowCount,
        avg_total: +avgTotal.toFixed(1),
        sort,
        filter,
      },
    })
  } finally { db.release() }
}
