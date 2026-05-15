import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { spreadSplitFromMove, totalSplitFromMove } from '@/lib/scoreboard/derive'

export const dynamic = 'force-dynamic'

// GET /api/viewer/scoreboard?sport=NBA&date=YYYY-MM-DD
//
// FanDuel-style scoreboard payload — one row per scheduled game on the
// requested date with spread + total + line-move-derived Bets%/Money%.
// Data comes from sports_games + sports_lines (populated by LinesLoop from
// The Odds API). Returns an empty array when no lines have been ingested.

type Sport = 'NBA' | 'NFL' | 'MLB'
type Market = 'spread' | 'total'

interface LineSnap {
  fanduel_current:   number | null
  fanduel_open:      number | null
  consensus_current: number | null
}

interface MarketDerived {
  bets_pct:  number | null
  money_pct: number | null
  popular_side: 'home' | 'away' | 'over' | 'under' | null
}

interface ScoreboardGame {
  game_id: number
  sport: Sport
  home_team: string
  home_abbr: string
  home_record: string
  away_team: string
  away_abbr: string
  away_record: string
  kickoff_at: number
  spread: (LineSnap & MarketDerived) | null
  total:  (LineSnap & MarketDerived) | null
}

const VALID_SPORTS: Record<Sport, string> = {
  NBA: 'nba',
  NFL: 'nfl',
  MLB: 'mlb',
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const sport = (url.searchParams.get('sport') ?? 'NBA').toUpperCase() as Sport
  const date  = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10)

  if (!VALID_SPORTS[sport]) {
    return NextResponse.json({
      games: [],
      meta: { sport, date, refreshed_ts: Date.now(), error: `unsupported sport: ${sport}` },
    })
  }
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ games: [], meta: { sport, date, refreshed_ts: Date.now() } })
  }

  const league = VALID_SPORTS[sport]
  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const rows = await db.query<GameRow>(
      `SELECT g.game_id,
              g.tipoff_at,
              th.city  AS home_city, th.name AS home_name,
              ta.city  AS away_city, ta.name AS away_name,
              sl_sp_fd.home_line       AS fanduel_home_spread,
              sl_sp_fd.open_home_line  AS fanduel_open_home_spread,
              sl_sp_cn.home_line       AS consensus_home_spread,
              sl_tt_fd.total_line      AS fanduel_total,
              sl_tt_fd.open_total      AS fanduel_open_total,
              sl_tt_cn.total_line      AS consensus_total
         FROM sports_games g
         JOIN sports_teams th ON th.team_id = g.home_team_id
         JOIN sports_teams ta ON ta.team_id = g.away_team_id
         LEFT JOIN sports_lines sl_sp_fd
           ON sl_sp_fd.game_id = g.game_id AND sl_sp_fd.book = 'fanduel'   AND sl_sp_fd.market = 'spread'
         LEFT JOIN sports_lines sl_sp_cn
           ON sl_sp_cn.game_id = g.game_id AND sl_sp_cn.book = 'consensus' AND sl_sp_cn.market = 'spread'
         LEFT JOIN sports_lines sl_tt_fd
           ON sl_tt_fd.game_id = g.game_id AND sl_tt_fd.book = 'fanduel'   AND sl_tt_fd.market = 'total'
         LEFT JOIN sports_lines sl_tt_cn
           ON sl_tt_cn.game_id = g.game_id AND sl_tt_cn.book = 'consensus' AND sl_tt_cn.market = 'total'
        WHERE g.league = $1
          AND g.tipoff_at::date = $2::date
        ORDER BY g.tipoff_at ASC`,
      [league, date],
    )

    const games: ScoreboardGame[] = rows.rows.map((r, i) => buildGame(r, sport, i))
    return NextResponse.json({
      games,
      meta: { sport, date, refreshed_ts: Date.now() },
    })
  } catch (e) {
    return NextResponse.json({
      games: [],
      meta: { sport, date, refreshed_ts: Date.now(), error: String(e).slice(0, 200) },
    })
  } finally {
    db.release()
  }
}

interface GameRow {
  game_id: string
  tipoff_at: Date
  home_city: string
  home_name: string
  away_city: string
  away_name: string
  fanduel_home_spread: string | null
  fanduel_open_home_spread: string | null
  consensus_home_spread: string | null
  fanduel_total: string | null
  fanduel_open_total: string | null
  consensus_total: string | null
}

function buildGame(r: GameRow, sport: Sport, ordinal: number): ScoreboardGame {
  const spreadCurrent = numOrNull(r.fanduel_home_spread)
  const spreadOpen    = numOrNull(r.fanduel_open_home_spread)
  const totalCurrent  = numOrNull(r.fanduel_total)
  const totalOpen     = numOrNull(r.fanduel_open_total)

  return {
    // Numeric id for the existing frontend key. sports_games.game_id is a
    // string slug; hash to a stable positive integer so React keys stay tidy.
    game_id: stableHash(r.game_id) ^ ordinal,
    sport,
    home_team:  `${r.home_city} ${r.home_name}`.trim(),
    home_abbr:  abbrev(r.home_city, r.home_name),
    home_record: '',
    away_team:  `${r.away_city} ${r.away_name}`.trim(),
    away_abbr:  abbrev(r.away_city, r.away_name),
    away_record: '',
    kickoff_at: r.tipoff_at.getTime(),
    spread: buildMarket('spread', {
      fanduel_current:   spreadCurrent,
      fanduel_open:      spreadOpen,
      consensus_current: numOrNull(r.consensus_home_spread),
    }),
    total: buildMarket('total', {
      fanduel_current:   totalCurrent,
      fanduel_open:      totalOpen,
      consensus_current: numOrNull(r.consensus_total),
    }),
  }
}

function buildMarket(kind: Market, snap: LineSnap): (LineSnap & MarketDerived) | null {
  if (snap.fanduel_current == null && snap.consensus_current == null) return null
  const split = kind === 'spread'
    ? spreadSplitFromMove(snap.fanduel_open, snap.fanduel_current)
    : totalSplitFromMove(snap.fanduel_open, snap.fanduel_current)
  return {
    ...snap,
    bets_pct:  split?.bets_pct  ?? null,
    money_pct: split?.money_pct ?? null,
    popular_side: split?.popular_side ?? null,
  }
}

function numOrNull(v: string | number | null | undefined): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function abbrev(city: string, name: string): string {
  const fromCity = city.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase()
  if (fromCity.length === 3) return fromCity
  return name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase()
}

function stableHash(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}
