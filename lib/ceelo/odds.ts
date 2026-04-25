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

export async function fetchNflLines(): Promise<BookLine[]> {
  if (!isConfigured()) return []
  // Stub: real call goes here once the key arrives.
  // Reference URL we'll hit:
  //   GET /sports/americanfootball_nfl/odds?regions=us&markets=spreads,totals,h2h
  //       &oddsFormat=american&apiKey=${ODDS_API_KEY}
  // The shape returned will need to be flattened into BookLine[].
  return []
}
