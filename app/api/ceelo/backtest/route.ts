import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { modelLine, DEFAULT_RATING, applyGame } from '@/lib/ceelo/ratings'
import type { Sport } from '@/lib/ceelo/teams'
import { ALL_SPORTS } from '@/lib/ceelo/teams'

export const dynamic = 'force-dynamic'

// POST /api/ceelo/backtest?sport=NFL|NBA|MLB|NHL|ALL
//
// Walks every completed game chronologically, computing Ceelo's model
// spread BEFORE applying each result, then comparing against the actual
// outcome:
//   - For NFL: compare model spread vs closing_spread (from nflverse) →
//     ATS record + accuracy. Subset on |edge| ≥ threshold to report
//     edge-game accuracy specifically.
//   - All sports: mean absolute error on the predicted home margin.
//
// Storage: stamps a row in ceelo_backtest. UI reads the latest per sport.
// Idempotent: ratings used during the walk are SHADOW ratings local to
// the function — does NOT touch ceelo_team_ratings.
//
// Tells the operator whether Ceelo's math actually beats the spread
// before any real money rides on a green light.

const EDGE_THRESHOLD: Record<Sport, number> = {
  NFL: 1.5,
  NBA: 1.5,
  MLB: 0.75,
  NHL: 0.75,
}

export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'no db' }, { status: 503 })

  const url = new URL(req.url)
  const sportParam = (url.searchParams.get('sport') ?? 'ALL').toUpperCase()
  const targets: Sport[] =
    sportParam === 'ALL' ? ALL_SPORTS
    : ALL_SPORTS.includes(sportParam as Sport) ? [sportParam as Sport] : []

  if (targets.length === 0) {
    return NextResponse.json({ error: `bad sport: ${sportParam}` }, { status: 400 })
  }

  const pool = getPool()
  const db = await pool.connect()
  const summaries: Array<Record<string, unknown>> = []
  try {
    await ensureSchema(db)

    for (const sport of targets) {
      const summary = await runBacktest(db, sport)
      // Persist
      await db.query(
        `INSERT INTO ceelo_backtest
           (sport, total_games, ats_wins, ats_losses, ats_pushes, ats_accuracy,
            edge_wins, edge_losses, edge_accuracy, edge_threshold,
            margin_mae, season_range, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          sport,
          summary.total_games,
          summary.ats_wins, summary.ats_losses, summary.ats_pushes, summary.ats_accuracy,
          summary.edge_wins, summary.edge_losses, summary.edge_accuracy, summary.edge_threshold,
          summary.margin_mae, summary.season_range, summary.notes,
        ]
      )
      summaries.push({ sport, ...summary })
    }

    return NextResponse.json({ ok: true, results: summaries })
  } finally { db.release() }
}

// GET /api/ceelo/backtest → latest result per sport.
export async function GET() {
  if (!process.env.DATABASE_URL) return NextResponse.json({ results: [] })
  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const { rows } = await db.query(
      `SELECT DISTINCT ON (sport)
              sport, total_games, ats_wins, ats_losses, ats_pushes, ats_accuracy,
              edge_wins, edge_losses, edge_accuracy, edge_threshold,
              margin_mae, season_range, notes,
              (EXTRACT(EPOCH FROM ran_at) * 1000)::bigint AS ran_ts
       FROM ceelo_backtest
       ORDER BY sport, ran_at DESC`
    )
    return NextResponse.json({
      results: rows.map(r => ({
        sport: r.sport,
        total_games: Number(r.total_games),
        ats_wins:    r.ats_wins != null ? Number(r.ats_wins) : null,
        ats_losses:  r.ats_losses != null ? Number(r.ats_losses) : null,
        ats_pushes:  r.ats_pushes != null ? Number(r.ats_pushes) : null,
        ats_accuracy: r.ats_accuracy != null ? Number(r.ats_accuracy) : null,
        edge_wins:    r.edge_wins != null ? Number(r.edge_wins) : null,
        edge_losses:  r.edge_losses != null ? Number(r.edge_losses) : null,
        edge_accuracy: r.edge_accuracy != null ? Number(r.edge_accuracy) : null,
        edge_threshold: r.edge_threshold != null ? Number(r.edge_threshold) : null,
        margin_mae:   r.margin_mae != null ? Number(r.margin_mae) : null,
        season_range: r.season_range,
        notes:        r.notes,
        ran_ts:       Number(r.ran_ts),
      })),
    })
  } finally { db.release() }
}

// ── core ────────────────────────────────────────────────────────────────

interface SummaryShape {
  total_games: number
  ats_wins: number | null
  ats_losses: number | null
  ats_pushes: number | null
  ats_accuracy: number | null
  edge_wins: number | null
  edge_losses: number | null
  edge_accuracy: number | null
  edge_threshold: number
  margin_mae: number | null
  season_range: string
  notes: string
}

async function runBacktest(db: import('pg').PoolClient, sport: Sport): Promise<SummaryShape> {
  // Pull every completed game for this sport, oldest first. We need
  // closing_spread (NFL only) for ATS grading + actual scores for the
  // Elo update + margin error.
  const { rows: games } = await db.query(
    `SELECT id, season, neutral_site, home_team, away_team,
            home_score, away_score, closing_spread, kickoff_at
     FROM ceelo_games
     WHERE sport = $1
       AND status = 'final'
       AND home_score IS NOT NULL AND away_score IS NOT NULL
     ORDER BY kickoff_at ASC`,
    [sport]
  )

  if (games.length === 0) {
    return {
      total_games: 0, ats_wins: null, ats_losses: null, ats_pushes: null, ats_accuracy: null,
      edge_wins: null, edge_losses: null, edge_accuracy: null,
      edge_threshold: EDGE_THRESHOLD[sport], margin_mae: null,
      season_range: 'none',
      notes: 'no completed games for this sport — seed first',
    }
  }

  // Shadow ratings local to the function — does NOT touch the real table.
  const ratings = new Map<string, number>()
  const getR = (t: string) => ratings.get(t) ?? DEFAULT_RATING
  const setR = (t: string, v: number) => ratings.set(t, v)

  let atsWins = 0, atsLosses = 0, atsPushes = 0
  let edgeWins = 0, edgeLosses = 0, edgePushes = 0
  let marginErrSum = 0, marginErrCount = 0

  const seasons = new Set<number>()
  const threshold = EDGE_THRESHOLD[sport]

  for (const g of games) {
    seasons.add(Number(g.season))

    // Predict BEFORE applying the result.
    const homeR = getR(g.home_team)
    const awayR = getR(g.away_team)
    const m = modelLine({ homeRating: homeR, awayRating: awayR, neutralSite: Boolean(g.neutral_site), sport })

    const margin = Number(g.home_score) - Number(g.away_score)
    // Margin MAE — predicted home_margin vs actual home_margin.
    // model_spread is home spread; predicted home_margin = -model_spread.
    const predictedMargin = -m.modelSpread
    marginErrSum += Math.abs(predictedMargin - margin)
    marginErrCount++

    // ATS grade — only when we have closing_spread.
    const close = g.closing_spread != null ? Number(g.closing_spread) : null
    if (close != null) {
      // Edge: closing_spread - model_spread. Positive ⇒ home undervalued ⇒
      // Ceelo would take HOME. Negative ⇒ Ceelo takes AWAY.
      const edge = close - m.modelSpread
      const takeHome = edge >= 0
      // For HOME pick at home_spread S = close: wins if margin + S > 0.
      // For AWAY pick: wins if margin + S < 0.
      const adjusted = takeHome ? (margin + close) : -(margin + close)
      let outcome: 'win' | 'loss' | 'push' =
        adjusted > 0.001 ? 'win'
      : adjusted < -0.001 ? 'loss'
      : 'push'

      if (outcome === 'win')   atsWins++
      else if (outcome === 'loss') atsLosses++
      else                          atsPushes++

      if (Math.abs(edge) >= threshold) {
        if (outcome === 'win')   edgeWins++
        else if (outcome === 'loss') edgeLosses++
        else                          edgePushes++
      }
    }

    // Apply Elo update with the actual result.
    const upd = applyGame({
      homeRating: homeR,
      awayRating: awayR,
      homeScore: Number(g.home_score),
      awayScore: Number(g.away_score),
      neutralSite: Boolean(g.neutral_site),
      sport,
    })
    setR(g.home_team, upd.homeNew)
    setR(g.away_team, upd.awayNew)
  }

  const atsTotal = atsWins + atsLosses
  const atsAccuracy = atsTotal > 0 ? +((atsWins / atsTotal) * 100).toFixed(2) : null

  const edgeTotal = edgeWins + edgeLosses
  const edgeAccuracy = edgeTotal > 0 ? +((edgeWins / edgeTotal) * 100).toFixed(2) : null

  const margin_mae = marginErrCount > 0 ? +(marginErrSum / marginErrCount).toFixed(2) : null

  const seasonsArr = Array.from(seasons).sort((a, b) => a - b)
  const seasonRange = seasonsArr.length === 0 ? 'none'
                    : seasonsArr.length === 1 ? String(seasonsArr[0])
                    : `${seasonsArr[0]}-${seasonsArr[seasonsArr.length - 1]}`

  const notes = atsTotal === 0
    ? `walked ${games.length} games — closing spreads not stored for this sport (margin MAE only)`
    : `walked ${games.length} games · ${atsTotal} ATS-graded · ${edgeTotal} ≥ ${threshold}-pt edge`

  return {
    total_games: games.length,
    ats_wins:   atsTotal > 0 ? atsWins : null,
    ats_losses: atsTotal > 0 ? atsLosses : null,
    ats_pushes: atsTotal > 0 ? atsPushes : null,
    ats_accuracy: atsAccuracy,
    edge_wins:    edgeTotal > 0 ? edgeWins : null,
    edge_losses:  edgeTotal > 0 ? edgeLosses : null,
    edge_accuracy: edgeAccuracy,
    edge_threshold: threshold,
    margin_mae,
    season_range: seasonRange,
    notes,
  }
}
