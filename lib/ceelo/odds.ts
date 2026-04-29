// The Odds API adapter — multi-sport. Stays a stub until ODDS_API_KEY is set.
// When the key is present, this fetches current spreads/totals/moneylines
// for upcoming games in the requested sport from a handful of US books.
//
// Free tier: 500 req/month total (across all sports). With three sports
// each refreshing every 30 min during their season, we still stay under
// the cap because seasons don't overlap fully.
//
// Docs: https://the-odds-api.com/liveapi/guides/v4/

import type { Sport } from './teams'

const BASE = 'https://api.the-odds-api.com/v4'

const SPORT_KEY: Record<Sport, string> = {
  NFL: 'americanfootball_nfl',
  NBA: 'basketball_nba',
  MLB: 'baseball_mlb',
  NHL: 'icehockey_nhl',
}

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

// Each sport's full team-name → canonical abbr map. The Odds API
// returns full team names; ESPN gives us abbrs. We need both in the
// same key space to match games across the two feeds.
const NFL_NAME_TO_ABBR: Record<string, string> = {
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

const NBA_NAME_TO_ABBR: Record<string, string> = {
  'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN',
  'Charlotte Hornets': 'CHA', 'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE',
  'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN', 'Detroit Pistons': 'DET',
  'Golden State Warriors': 'GS', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
  'LA Clippers': 'LAC', 'Los Angeles Clippers': 'LAC',
  'Los Angeles Lakers': 'LAL', 'Memphis Grizzlies': 'MEM', 'Miami Heat': 'MIA',
  'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN',
  'New Orleans Pelicans': 'NO', 'New York Knicks': 'NY',
  'Oklahoma City Thunder': 'OKC', 'Orlando Magic': 'ORL',
  'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX',
  'Portland Trail Blazers': 'POR', 'Sacramento Kings': 'SAC',
  'San Antonio Spurs': 'SA', 'Toronto Raptors': 'TOR',
  'Utah Jazz': 'UTAH', 'Washington Wizards': 'WSH',
}

const MLB_NAME_TO_ABBR: Record<string, string> = {
  'Arizona Diamondbacks': 'ARI', 'Atlanta Braves': 'ATL', 'Baltimore Orioles': 'BAL',
  'Boston Red Sox': 'BOS', 'Chicago Cubs': 'CHC', 'Chicago White Sox': 'CHW',
  'Cincinnati Reds': 'CIN', 'Cleveland Guardians': 'CLE', 'Colorado Rockies': 'COL',
  'Detroit Tigers': 'DET', 'Houston Astros': 'HOU', 'Kansas City Royals': 'KC',
  'Los Angeles Angels': 'LAA', 'Los Angeles Dodgers': 'LAD', 'Miami Marlins': 'MIA',
  'Milwaukee Brewers': 'MIL', 'Minnesota Twins': 'MIN', 'New York Mets': 'NYM',
  'New York Yankees': 'NYY', 'Oakland Athletics': 'OAK', 'Athletics': 'ATH',
  'Philadelphia Phillies': 'PHI', 'Pittsburgh Pirates': 'PIT', 'San Diego Padres': 'SD',
  'Seattle Mariners': 'SEA', 'San Francisco Giants': 'SF', 'St. Louis Cardinals': 'STL',
  'Tampa Bay Rays': 'TB', 'Texas Rangers': 'TEX', 'Toronto Blue Jays': 'TOR',
  'Washington Nationals': 'WSH',
}

const NHL_NAME_TO_ABBR: Record<string, string> = {
  'Anaheim Ducks': 'ANA', 'Boston Bruins': 'BOS', 'Buffalo Sabres': 'BUF',
  'Calgary Flames': 'CGY', 'Carolina Hurricanes': 'CAR', 'Chicago Blackhawks': 'CHI',
  'Colorado Avalanche': 'COL', 'Columbus Blue Jackets': 'CBJ',
  'Dallas Stars': 'DAL', 'Detroit Red Wings': 'DET', 'Edmonton Oilers': 'EDM',
  'Florida Panthers': 'FLA', 'Los Angeles Kings': 'LA', 'Minnesota Wild': 'MIN',
  'Montreal Canadiens': 'MTL', 'Montréal Canadiens': 'MTL',
  'Nashville Predators': 'NSH', 'New Jersey Devils': 'NJ',
  'New York Islanders': 'NYI', 'New York Rangers': 'NYR',
  'Ottawa Senators': 'OTT', 'Philadelphia Flyers': 'PHI',
  'Pittsburgh Penguins': 'PIT', 'San Jose Sharks': 'SJ',
  'Seattle Kraken': 'SEA', 'St. Louis Blues': 'STL', 'St Louis Blues': 'STL',
  'Tampa Bay Lightning': 'TB', 'Toronto Maple Leafs': 'TOR',
  // Coyotes relocated to Utah (Mammoth) — Odds API may emit either
  // legacy or current name during the transition window.
  'Utah Hockey Club': 'UTA', 'Utah Mammoth': 'UTA', 'Arizona Coyotes': 'UTA',
  'Vancouver Canucks': 'VAN', 'Vegas Golden Knights': 'VGK',
  'Washington Capitals': 'WSH', 'Winnipeg Jets': 'WPG',
}

const NAME_TO_ABBR_BY_SPORT: Record<Sport, Record<string, string>> = {
  NFL: NFL_NAME_TO_ABBR,
  NBA: NBA_NAME_TO_ABBR,
  MLB: MLB_NAME_TO_ABBR,
  NHL: NHL_NAME_TO_ABBR,
}

// Sport-aware fetch. Dispatches on sport key + name map.
export async function fetchLines(sport: Sport): Promise<BookLine[]> {
  const key = process.env.ODDS_API_KEY
  if (!key) return []
  const map = NAME_TO_ABBR_BY_SPORT[sport]
  const sportKey = SPORT_KEY[sport]

  const url = `${BASE}/sports/${sportKey}/odds?regions=us&markets=spreads,totals,h2h&oddsFormat=american&apiKey=${key}`
  const res = await fetch(url)
  if (!res.ok) {
    console.error(`Odds API ${sport} returned ${res.status}`)
    return []
  }
  const data = await res.json()
  return parseGames(data, map)
}

interface OddsApiOutcome { name: string; price: number; point?: number }
interface OddsApiMarket  { key: string; outcomes: OddsApiOutcome[] }
interface OddsApiBookmaker { key: string; markets: OddsApiMarket[] }
interface OddsApiGame {
  home_team: string
  away_team: string
  commence_time: string
  bookmakers: OddsApiBookmaker[]
}

function parseGames(games: OddsApiGame[], nameMap: Record<string, string>): BookLine[] {
  const out: BookLine[] = []
  for (const game of games) {
    const home = nameMap[game.home_team]
    const away = nameMap[game.away_team]
    if (!home || !away) continue

    for (const bookmaker of game.bookmakers ?? []) {
      const bookName = bookmaker.key
      let spreadMatch: OddsApiMarket | null = null
      let totalMatch:  OddsApiMarket | null = null
      let h2hMatch:    OddsApiMarket | null = null
      for (const m of bookmaker.markets ?? []) {
        if (m.key === 'spreads') spreadMatch = m
        if (m.key === 'totals')  totalMatch  = m
        if (m.key === 'h2h')     h2hMatch    = m
      }
      if (spreadMatch?.outcomes) {
        const h = spreadMatch.outcomes.find(o => o.name === game.home_team)
        const a = spreadMatch.outcomes.find(o => o.name === game.away_team)
        if (h && a) out.push({
          espn_id_hint: null, home_team: home, away_team: away,
          kickoff_at: game.commence_time, book: bookName, market: 'spread',
          home_line: h.point ?? null, total_line: null,
          home_odds: h.price, away_odds: a.price, over_odds: null, under_odds: null,
        })
      }
      if (totalMatch?.outcomes) {
        const o = totalMatch.outcomes.find(x => x.name === 'Over')
        const u = totalMatch.outcomes.find(x => x.name === 'Under')
        if (o && u) out.push({
          espn_id_hint: null, home_team: home, away_team: away,
          kickoff_at: game.commence_time, book: bookName, market: 'total',
          home_line: null, total_line: o.point ?? null,
          home_odds: null, away_odds: null, over_odds: o.price, under_odds: u.price,
        })
      }
      if (h2hMatch?.outcomes) {
        const h = h2hMatch.outcomes.find(o => o.name === game.home_team)
        const a = h2hMatch.outcomes.find(o => o.name === game.away_team)
        if (h && a) out.push({
          espn_id_hint: null, home_team: home, away_team: away,
          kickoff_at: game.commence_time, book: bookName, market: 'moneyline',
          home_line: null, total_line: null,
          home_odds: h.price, away_odds: a.price, over_odds: null, under_odds: null,
        })
      }
    }
  }
  return out
}

// Back-compat: existing callers still use fetchNflLines. Delegates.
export async function fetchNflLines(): Promise<BookLine[]> {
  return fetchLines('NFL')
}
