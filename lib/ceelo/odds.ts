// The Odds API adapter — stays a stub until ODDS_API_KEY is set.
// When the key is present, this fetches current spreads/totals/moneylines
// for upcoming NFL games from a small handful of US books.
//
// Free tier: 500 req/month → enough to poll once per hour during the
// season (≈720 hours ÷ 30-min cycles = ~360 polls if we ran every 30 min).
// We call this at most every CEELO_ODDS_REFRESH_MIN minutes.
//
// Docs: https://the-odds-api.com/liveapi/guides/v4/

const BASE = 'https://api.the-odds-api.com/v4'

export interface BookLine {
  espn_id_hint: string | null   // ESPN doesn't share IDs; we match on (home,away,kickoff)
  home_team: string
  away_team: string
  kickoff_at: string            // ISO 8601
  book: string                  // 'draftkings' | 'fanduel' | etc.
  market: 'spread' | 'total' | 'moneyline'
  home_line: number | null
  total_line: number | null
  home_odds: number | null
  away_odds: number | null
  over_odds: number | null
  under_odds: number | null
}

export function isConfigured(): boolean {
  return !!process.env.ODDS_API_KEY
}

const NAME_TO_ABBR: Record<string, string> = {
  'Arizona Cardinals': 'ARI',
  'Atlanta Falcons': 'ATL',
  'Baltimore Ravens': 'BAL',
  'Buffalo Bills': 'BUF',
  'Carolina Panthers': 'CAR',
  'Chicago Bears': 'CHI',
  'Cincinnati Bengals': 'CIN',
  'Cleveland Browns': 'CLE',
  'Dallas Cowboys': 'DAL',
  'Denver Broncos': 'DEN',
  'Detroit Lions': 'DET',
  'Green Bay Packers': 'GB',
  'Houston Texans': 'HOU',
  'Indianapolis Colts': 'IND',
  'Jacksonville Jaguars': 'JAX',
  'Kansas City Chiefs': 'KC',
  'Las Vegas Raiders': 'LV',
  'Los Angeles Chargers': 'LAC',
  'Los Angeles Rams': 'LAR',
  'Miami Dolphins': 'MIA',
  'Minnesota Vikings': 'MIN',
  'New England Patriots': 'NE',
  'New Orleans Saints': 'NO',
  'New York Giants': 'NYG',
  'New York Jets': 'NYJ',
  'Philadelphia Eagles': 'PHI',
  'Pittsburgh Steelers': 'PIT',
  'San Francisco 49ers': 'SF',
  'Seattle Seahawks': 'SEA',
  'Tampa Bay Buccaneers': 'TB',
  'Tennessee Titans': 'TEN',
  'Washington Commanders': 'WSH',
}

export async function fetchNflLines(): Promise<BookLine[]> {
  const key = process.env.ODDS_API_KEY
  if (!key) return []

  const url = `${BASE}/sports/americanfootball_nfl/odds?regions=us&markets=spreads,totals,h2h&oddsFormat=american&apiKey=${key}`
  const res = await fetch(url)
  if (!res.ok) {
    console.error(`Odds API returned ${res.status}`)
    return []
  }

  const data = await res.json()
  const out: BookLine[] = []

  for (const game of data) {
    const home = NAME_TO_ABBR[game.home_team]
    const away = NAME_TO_ABBR[game.away_team]
    if (!home || !away) continue

    for (const bookmaker of game.bookmakers) {
      const bookName = bookmaker.key

      interface Outcome { name: string; price: number; point?: number }
      interface Market { key: string; outcomes: Outcome[] }

      let spreadMatch: Market | null = null
      let totalMatch: Market | null = null
      let h2hMatch: Market | null = null

      for (const m of bookmaker.markets) {
        if (m.key === 'spreads') spreadMatch = m as Market
        if (m.key === 'totals') totalMatch = m as Market
        if (m.key === 'h2h') h2hMatch = m as Market
      }

      if (spreadMatch && Array.isArray(spreadMatch.outcomes)) {
        const homeOutcome = spreadMatch.outcomes.find((o: Outcome) => o.name === game.home_team)
        const awayOutcome = spreadMatch.outcomes.find((o: Outcome) => o.name === game.away_team)
        if (homeOutcome && awayOutcome) {
          out.push({
            espn_id_hint: null,
            home_team: home,
            away_team: away,
            kickoff_at: game.commence_time,
            book: bookName,
            market: 'spread',
            home_line: homeOutcome.point ?? null,
            total_line: null,
            home_odds: homeOutcome.price,
            away_odds: awayOutcome.price,
            over_odds: null,
            under_odds: null,
          })
        }
      }

      if (totalMatch && Array.isArray(totalMatch.outcomes)) {
        const over = totalMatch.outcomes.find((o: Outcome) => o.name === 'Over')
        const under = totalMatch.outcomes.find((o: Outcome) => o.name === 'Under')
        if (over && under) {
          out.push({
            espn_id_hint: null,
            home_team: home,
            away_team: away,
            kickoff_at: game.commence_time,
            book: bookName,
            market: 'total',
            home_line: null,
            total_line: over.point ?? null,
            home_odds: null,
            away_odds: null,
            over_odds: over.price,
            under_odds: under.price,
          })
        }
      }

      if (h2hMatch && Array.isArray(h2hMatch.outcomes)) {
        const homeOutcome = h2hMatch.outcomes.find((o: Outcome) => o.name === game.home_team)
        const awayOutcome = h2hMatch.outcomes.find((o: Outcome) => o.name === game.away_team)
        if (homeOutcome && awayOutcome) {
          out.push({
            espn_id_hint: null,
            home_team: home,
            away_team: away,
            kickoff_at: game.commence_time,
            book: bookName,
            market: 'moneyline',
            home_line: null,
            total_line: null,
            home_odds: homeOutcome.price,
            away_odds: awayOutcome.price,
            over_odds: null,
            under_odds: null,
          })
        }
      }
    }
  }

  return out
}
