// /api/viewer/scoreboard — packs the FanDuel-style scoreboard rows for
// /theyield/sports. Returns one row per game for the requested sport
// on the requested date, with FanDuel + consensus snapshots for the spread
// and total markets and a heuristic Bets%/Money% derived from line move.

import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { spreadSplitFromMove, totalSplitFromMove } from '@/lib/scoreboard/derive'

export const dynamic = 'force-dynamic'
export const revalidate = 0

type Sport = 'NFL' | 'NBA' | 'MLB'
const ALLOWED: Sport[] = ['NFL', 'NBA', 'MLB']

const ABBR: Record<Sport, Record<string, string>> = {
  NFL: {
    'Arizona Cardinals': 'ARI', 'Atlanta Falcons': 'ATL', 'Baltimore Ravens': 'BAL',
    'Buffalo Bills': 'BUF', 'Carolina Panthers': 'CAR', 'Chicago Bears': 'CHI',
    'Cincinnati Bengals': 'CIN', 'Cleveland Browns': 'CLE', 'Dallas Cowboys': 'DAL',
    'Denver Broncos': 'DEN', 'Detroit Lions': 'DET', 'Green Bay Packers': 'GB',
    'Houston Texans': 'HOU', 'Indianapolis Colts': 'IND', 'Jacksonville Jaguars': 'JAX',
    'Kansas City Chiefs': 'KC', 'Las Vegas Raiders': 'LV', 'Los Angeles Chargers': 'LAC',
    'Los Angeles Rams': 'LAR', 'Miami Dolphins': 'MIA', 'Minnesota Vikings': 'MIN',
    'New England Patriots': 'NE', 'New Orleans Saints': 'NO', 'New York Giants': 'NYG',
    'New York Jets': 'NYJ', 'Philadelphia Eagles': 'PHI', 'Pittsburgh Steelers': 'PIT',
    'San Francisco 49ers': 'SF', 'Seattle Seahawks': 'SEA', 'Tampa Bay Buccaneers': 'TB',
    'Tennessee Titans': 'TEN', 'Washington Commanders': 'WSH',
  },
  NBA: {
    'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN',
    'Charlotte Hornets': 'CHA', 'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE',
    'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN', 'Detroit Pistons': 'DET',
    'Golden State Warriors': 'GS', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
    'LA Clippers': 'LAC', 'Los Angeles Lakers': 'LAL', 'Memphis Grizzlies': 'MEM',
    'Miami Heat': 'MIA', 'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN',
    'New Orleans Pelicans': 'NO', 'New York Knicks': 'NY', 'Oklahoma City Thunder': 'OKC',
    'Orlando Magic': 'ORL', 'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX',
    'Portland Trail Blazers': 'POR', 'Sacramento Kings': 'SAC', 'San Antonio Spurs': 'SA',
    'Toronto Raptors': 'TOR', 'Utah Jazz': 'UTAH', 'Washington Wizards': 'WSH',
  },
  MLB: {
    'Arizona Diamondbacks': 'ARI', 'Atlanta Braves': 'ATL', 'Baltimore Orioles': 'BAL',
    'Boston Red Sox': 'BOS', 'Chicago Cubs': 'CHC', 'Chicago White Sox': 'CHW',
    'Cincinnati Reds': 'CIN', 'Cleveland Guardians': 'CLE', 'Colorado Rockies': 'COL',
    'Detroit Tigers': 'DET', 'Houston Astros': 'HOU', 'Kansas City Royals': 'KC',
    'Los Angeles Angels': 'LAA', 'Los Angeles Dodgers': 'LAD', 'Miami Marlins': 'MIA',
    'Milwaukee Brewers': 'MIL', 'Minnesota Twins': 'MIN', 'New York Mets': 'NYM',
    'New York Yankees': 'NYY', 'Oakland Athletics': 'OAK', 'Philadelphia Phillies': 'PHI',
    'Pittsburgh Pirates': 'PIT', 'San Diego Padres': 'SD', 'Seattle Mariners': 'SEA',
    'San Francisco Giants': 'SF', 'St. Louis Cardinals': 'STL', 'Tampa Bay Rays': 'TB',
    'Texas Rangers': 'TEX', 'Toronto Blue Jays': 'TOR', 'Washington Nationals': 'WSH',
  },
}

function abbrOf(sport: Sport, name: string): string {
  return ABBR[sport][name] ?? name.slice(0, 3).toUpperCase()
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const rawSport = (url.searchParams.get('sport') ?? 'NBA').toUpperCase()
  const sport: Sport = (ALLOWED as string[]).includes(rawSport) ? (rawSport as Sport) : 'NBA'
  const date = url.searchParams.get('date') ?? isoDate(new Date())

  const empty = NextResponse.json({ games: [], meta: { sport, date, refreshed_ts: Date.now() } })
  if (!process.env.DATABASE_URL) return empty

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const { rows: gameRows } = await db.query(
      `SELECT g.id AS game_id, g.sport, g.home_team, g.away_team,
              (EXTRACT(EPOCH FROM g.kickoff_at) * 1000)::bigint AS kickoff_ts
       FROM ceelo_games g
       WHERE g.sport = $1
         AND g.status IN ('scheduled', 'live')
         AND (g.kickoff_at AT TIME ZONE 'UTC')::date = $2::date
       ORDER BY g.kickoff_at ASC`,
      [sport, date]
    )

    if (gameRows.length === 0) {
      return NextResponse.json({ games: [], meta: { sport, date, refreshed_ts: Date.now() } })
    }

    const gameIds = gameRows.map(r => Number(r.game_id))

    // Per-game per-book per-market: latest line + earliest (open) line.
    const { rows: lineRows } = await db.query(
      `WITH ordered AS (
         SELECT
           game_id, book, market, home_line, total_line,
           public_bets_pct, public_money_pct, public_side,
           ROW_NUMBER() OVER (PARTITION BY game_id, book, market ORDER BY fetched_at DESC) AS rn_desc,
           ROW_NUMBER() OVER (PARTITION BY game_id, book, market ORDER BY fetched_at ASC)  AS rn_asc
         FROM ceelo_lines
         WHERE game_id = ANY($1::int[])
           AND market IN ('spread', 'total')
       )
       SELECT
         game_id, book, market,
         MAX(CASE WHEN rn_desc = 1 THEN home_line END)        AS home_line_current,
         MAX(CASE WHEN rn_desc = 1 THEN total_line END)       AS total_line_current,
         MAX(CASE WHEN rn_asc  = 1 THEN home_line END)        AS home_line_open,
         MAX(CASE WHEN rn_asc  = 1 THEN total_line END)       AS total_line_open,
         MAX(CASE WHEN rn_desc = 1 THEN public_bets_pct END)  AS public_bets_pct,
         MAX(CASE WHEN rn_desc = 1 THEN public_money_pct END) AS public_money_pct,
         MAX(CASE WHEN rn_desc = 1 THEN public_side END)      AS public_side
       FROM ordered
       GROUP BY game_id, book, market`,
      [gameIds]
    )

    type SnapKey = `${number}|${string}|${string}` // gameId|book|market
    const snaps = new Map<SnapKey, {
      home_line_current: number | null
      total_line_current: number | null
      home_line_open: number | null
      total_line_open: number | null
      public_bets_pct: number | null
      public_money_pct: number | null
      public_side: string | null
    }>()
    for (const r of lineRows) {
      snaps.set(`${Number(r.game_id)}|${r.book}|${r.market}`, {
        home_line_current:  r.home_line_current  != null ? Number(r.home_line_current)  : null,
        total_line_current: r.total_line_current != null ? Number(r.total_line_current) : null,
        home_line_open:     r.home_line_open     != null ? Number(r.home_line_open)     : null,
        total_line_open:    r.total_line_open    != null ? Number(r.total_line_open)    : null,
        public_bets_pct:    r.public_bets_pct    != null ? Number(r.public_bets_pct)    : null,
        public_money_pct:   r.public_money_pct   != null ? Number(r.public_money_pct)   : null,
        public_side:        r.public_side ?? null,
      })
    }

    // Latest-season records for the per-team W-L stamp.
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
    const wl = new Map<string, { w: number; l: number }>()
    for (const r of recordRows) {
      if (Number(r.season) !== latestSeason) continue
      const w = wl.get(r.winner) ?? { w: 0, l: 0 }; w.w++; wl.set(r.winner, w)
      const l = wl.get(r.loser)  ?? { w: 0, l: 0 }; l.l++; wl.set(r.loser, l)
    }
    const recOf = (t: string) => { const x = wl.get(t); return x ? `${x.w}-${x.l}` : '0-0' }

    const games = gameRows.map(g => {
      const id = Number(g.game_id)

      // Spread: FanDuel for fanduel_* columns, consensus = avg across books.
      const spreadFd = snaps.get(`${id}|fanduel|spread`)
      const spreadAll = ['fanduel', 'draftkings', 'betmgm', 'caesars', 'pointsbetus']
        .map(b => snaps.get(`${id}|${b}|spread`)?.home_line_current)
        .filter((x): x is number => x != null)
      const spreadConsensus = spreadAll.length ? +(spreadAll.reduce((s, x) => s + x, 0) / spreadAll.length).toFixed(2) : null

      // Totals
      const totalFd = snaps.get(`${id}|fanduel|total`)
      const totalAll = ['fanduel', 'draftkings', 'betmgm', 'caesars', 'pointsbetus']
        .map(b => snaps.get(`${id}|${b}|total`)?.total_line_current)
        .filter((x): x is number => x != null)
      const totalConsensus = totalAll.length ? +(totalAll.reduce((s, x) => s + x, 0) / totalAll.length).toFixed(2) : null

      const spreadDerived = (() => {
        // Prefer the real scraped split when present.
        if (spreadFd?.public_bets_pct != null && (spreadFd.public_side === 'home' || spreadFd.public_side === 'away')) {
          return {
            bets_pct:     Math.round(spreadFd.public_bets_pct),
            money_pct:    spreadFd.public_money_pct != null ? Math.round(spreadFd.public_money_pct) : null,
            popular_side: spreadFd.public_side as 'home' | 'away',
          }
        }
        return spreadSplitFromMove(spreadFd?.home_line_open ?? null, spreadFd?.home_line_current ?? null)
      })()

      const totalDerived = (() => {
        if (totalFd?.public_bets_pct != null && (totalFd.public_side === 'over' || totalFd.public_side === 'under')) {
          return {
            bets_pct:     Math.round(totalFd.public_bets_pct),
            money_pct:    totalFd.public_money_pct != null ? Math.round(totalFd.public_money_pct) : null,
            popular_side: totalFd.public_side as 'over' | 'under',
          }
        }
        return totalSplitFromMove(totalFd?.total_line_open ?? null, totalFd?.total_line_current ?? null)
      })()

      const spread = spreadFd || spreadConsensus != null
        ? {
            fanduel_current:   spreadFd?.home_line_current ?? null,
            fanduel_open:      spreadFd?.home_line_open ?? null,
            consensus_current: spreadConsensus,
            bets_pct:     spreadDerived?.bets_pct  ?? null,
            money_pct:    spreadDerived?.money_pct ?? null,
            popular_side: spreadDerived?.popular_side ?? null,
          }
        : null

      const total = totalFd || totalConsensus != null
        ? {
            fanduel_current:   totalFd?.total_line_current ?? null,
            fanduel_open:      totalFd?.total_line_open ?? null,
            consensus_current: totalConsensus,
            bets_pct:     totalDerived?.bets_pct  ?? null,
            money_pct:    totalDerived?.money_pct ?? null,
            popular_side: totalDerived?.popular_side ?? null,
          }
        : null

      return {
        game_id: id,
        sport: g.sport as Sport,
        home_team: g.home_team,
        home_abbr: abbrOf(sport, g.home_team),
        home_record: recOf(g.home_team),
        away_team: g.away_team,
        away_abbr: abbrOf(sport, g.away_team),
        away_record: recOf(g.away_team),
        kickoff_at: Number(g.kickoff_ts),
        spread,
        total,
      }
    })

    return NextResponse.json({
      games,
      meta: { sport, date, refreshed_ts: Date.now() },
    })
  } catch (err) {
    console.error('[scoreboard] query failed', err)
    return empty
  } finally {
    db.release()
  }
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
