import type { PoolClient } from 'pg'
import { fetchLines, NAME_TO_ABBR_BY_SPORT, type BookLine } from '../ceelo/legacy/odds'
import type { Sport } from '../ceelo/legacy/teams'

// Lines ingestion. Pulls point spreads + totals from The Odds API for the
// in-season leagues (NBA/NFL/MLB) and upserts them into sports_lines, one
// row per (game, book, market). The open_* columns are captured on first
// insert and never overwritten — Bets%/Money% downstream is derived from
// the open → current movement via lib/scoreboard/derive.ts.
//
// Self-gates on ODDS_API_KEY. Idle when the key is absent so a missing key
// can never crash the agent tick.

const LEAGUE_BY_SPORT: Record<Sport, string> = {
  NBA: 'nba',
  NFL: 'nfl',
  MLB: 'mlb',
}

const SPORTS: Sport[] = ['NBA', 'NFL', 'MLB']

// Books we explicitly persist per (game, market). Anything we receive from a
// listed book is kept as-is; the synthetic 'consensus' row is the median of
// home_line / total_line across every book we saw for that market.
const BOOKS_TRACKED: Record<string, true> = {
  fanduel: true,
  draftkings: true,
  betmgm: true,
}

export class LinesLoop {
  constructor(private readonly db: PoolClient) {}

  async run(): Promise<{ logMessage: string; logType: 'info' | 'success' | 'warn' } | null> {
    if (!process.env.ODDS_API_KEY) {
      return { logMessage: 'Lines: ODDS_API_KEY unset — skipping.', logType: 'info' }
    }

    let inserted = 0
    let skipped = 0
    const perSport: Record<string, number> = {}

    for (const sport of SPORTS) {
      try {
        const lines = await fetchLines(sport)
        if (lines.length === 0) {
          perSport[sport] = 0
          continue
        }

        const gameIndex = await this.buildGameIndex(sport)
        const grouped = groupByGame(lines)

        let countForSport = 0
        for (const { abbrHome, abbrAway, kickoffYmd, byBookMarket } of grouped) {
          const game_id = gameIndex.get(matchupKey(abbrHome, abbrAway, kickoffYmd))
          if (!game_id) { skipped++; continue }

          // Persist each tracked book + a synthetic consensus per market.
          for (const market of ['spread', 'total'] as const) {
            const byBook = byBookMarket[market]
            const values: number[] = []
            for (const [book, ln] of byBook.entries()) {
              if (BOOKS_TRACKED[book]) {
                await this.upsert(game_id, book, market, ln)
                inserted++
                countForSport++
              }
              const v = market === 'spread' ? ln.home_line : ln.total_line
              if (v != null) values.push(v)
            }
            if (values.length > 0) {
              const consensus = median(values)
              await this.upsertConsensus(game_id, market, consensus)
              inserted++
              countForSport++
            }
          }
        }
        perSport[sport] = countForSport
      } catch (e) {
        await this.db.query(
          `INSERT INTO lila_log (message, type) VALUES ($1, 'warn')`,
          [`Lines: ${sport} fetch failed: ${String(e).slice(0, 200)}`],
        )
      }
    }

    const summary = SPORTS.map(s => `${s}=${perSport[s] ?? 0}`).join(' ')
    return {
      logMessage: `Lines: upserted ${inserted} rows (${summary})${skipped ? `, skipped ${skipped} unmatched` : ''}.`,
      logType: inserted ? 'success' : 'info',
    }
  }

  private async buildGameIndex(sport: Sport): Promise<Map<string, string>> {
    const league = LEAGUE_BY_SPORT[sport]
    const { rows } = await this.db.query<{
      game_id: string
      tipoff_at: Date
      home_city: string
      home_name: string
      away_city: string
      away_name: string
    }>(
      `SELECT g.game_id, g.tipoff_at,
              th.city AS home_city, th.name AS home_name,
              ta.city AS away_city, ta.name AS away_name
         FROM sports_games g
         JOIN sports_teams th ON th.team_id = g.home_team_id
         JOIN sports_teams ta ON ta.team_id = g.away_team_id
        WHERE g.league = $1
          AND g.tipoff_at > NOW() - INTERVAL '12 hours'
          AND g.tipoff_at < NOW() + INTERVAL '7 days'`,
      [league],
    )
    const nameMap = NAME_TO_ABBR_BY_SPORT[sport]
    const idx = new Map<string, string>()
    for (const r of rows) {
      const home = lookupAbbr(nameMap, r.home_city, r.home_name)
      const away = lookupAbbr(nameMap, r.away_city, r.away_name)
      if (!home || !away) continue
      const ymd = ymdUTC(r.tipoff_at)
      idx.set(matchupKey(home, away, ymd), r.game_id)
    }
    return idx
  }

  private async upsert(
    game_id: string,
    book: string,
    market: 'spread' | 'total',
    ln: BookLine,
  ): Promise<void> {
    const home_line  = market === 'spread' ? ln.home_line  : null
    const total_line = market === 'total'  ? ln.total_line : null
    await this.writeRow(game_id, book, market, home_line, total_line)
  }

  private async upsertConsensus(
    game_id: string,
    market: 'spread' | 'total',
    value: number,
  ): Promise<void> {
    const home_line  = market === 'spread' ? value : null
    const total_line = market === 'total'  ? value : null
    await this.writeRow(game_id, 'consensus', market, home_line, total_line)
  }

  private async writeRow(
    game_id: string,
    book: string,
    market: 'spread' | 'total',
    home_line: number | null,
    total_line: number | null,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO sports_lines (game_id, book, market, home_line, total_line, open_home_line, open_total, observed_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $4, $5, NOW(), NOW())
         ON CONFLICT (game_id, book, market) DO UPDATE
           SET home_line   = EXCLUDED.home_line,
               total_line  = EXCLUDED.total_line,
               updated_at  = NOW()`,
      [game_id, book, market, home_line, total_line],
    )
  }
}

function groupByGame(lines: BookLine[]): Array<{
  abbrHome: string
  abbrAway: string
  kickoffYmd: string
  byBookMarket: { spread: Map<string, BookLine>; total: Map<string, BookLine> }
}> {
  const buckets = new Map<string, ReturnType<typeof emptyBucket>>()
  for (const ln of lines) {
    if (ln.market !== 'spread' && ln.market !== 'total') continue
    const ymd = ymdUTC(new Date(ln.kickoff_at))
    const key = matchupKey(ln.home_team, ln.away_team, ymd)
    let b = buckets.get(key)
    if (!b) {
      b = emptyBucket()
      b.abbrHome = ln.home_team
      b.abbrAway = ln.away_team
      b.kickoffYmd = ymd
      buckets.set(key, b)
    }
    b.byBookMarket[ln.market].set(ln.book, ln)
  }
  return Array.from(buckets.values())
}

function emptyBucket() {
  return {
    abbrHome: '',
    abbrAway: '',
    kickoffYmd: '',
    byBookMarket: {
      spread: new Map<string, BookLine>(),
      total:  new Map<string, BookLine>(),
    },
  }
}

function matchupKey(home: string, away: string, ymd: string): string {
  return `${home}@${away}#${ymd}`
}

function ymdUTC(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// Resolve a (city, name) tuple from sports_teams to the ESPN abbreviation
// The Odds API uses. The legacy NAME_TO_ABBR_BY_SPORT maps key on the full
// "City Name" string ("Boston Celtics"); we try a few common shapes before
// giving up.
function lookupAbbr(
  map: Record<string, string>,
  city: string,
  name: string,
): string | null {
  const full = `${city} ${name}`.trim()
  return map[full] ?? map[name] ?? map[city] ?? null
}
