// Public betting % per game, free + scrapable.
//
// Source: Action Network's web-scoreboard JSON. Their public website
// uses these endpoints itself, so they're stable + don't require auth.
// Each game carries `consensus.spread` with bet/handle splits per side.
//
// If the source breaks (rate limit / schema change), we degrade silently
// — public_bets_pct stays NULL on the line and the EdgeBoard renders '—'.
//
//   GET https://api.actionnetwork.com/web/v2/scoreboard/{sport}?bookIds=15&date=YYYYMMDD

import type { Sport } from './teams'

const SPORT_PATH: Record<Sport, string> = {
  NFL: 'nfl',
  NBA: 'nba',
  MLB: 'mlb',
  NHL: 'nhl',
}

// ESPN-canonical abbr lookup keyed on Action Network's city + name.
// Action Network uses team display names, not abbreviations.
const NFL_TEAM_BY_NAME: Record<string, string> = {
  'Cardinals': 'ARI', 'Falcons': 'ATL', 'Ravens': 'BAL', 'Bills': 'BUF',
  'Panthers': 'CAR', 'Bears': 'CHI', 'Bengals': 'CIN', 'Browns': 'CLE',
  'Cowboys': 'DAL', 'Broncos': 'DEN', 'Lions': 'DET', 'Packers': 'GB',
  'Texans': 'HOU', 'Colts': 'IND', 'Jaguars': 'JAX', 'Chiefs': 'KC',
  'Chargers': 'LAC', 'Rams': 'LAR', 'Raiders': 'LV',
  'Dolphins': 'MIA', 'Vikings': 'MIN', 'Patriots': 'NE',
  'Saints': 'NO', 'Giants': 'NYG', 'Jets': 'NYJ',
  'Eagles': 'PHI', 'Steelers': 'PIT', 'Seahawks': 'SEA', '49ers': 'SF',
  'Buccaneers': 'TB', 'Titans': 'TEN', 'Commanders': 'WSH',
}

const NBA_TEAM_BY_NAME: Record<string, string> = {
  'Hawks': 'ATL', 'Celtics': 'BOS', 'Nets': 'BKN', 'Hornets': 'CHA',
  'Bulls': 'CHI', 'Cavaliers': 'CLE', 'Mavericks': 'DAL', 'Nuggets': 'DEN',
  'Pistons': 'DET', 'Warriors': 'GS', 'Rockets': 'HOU', 'Pacers': 'IND',
  'Clippers': 'LAC', 'Lakers': 'LAL', 'Grizzlies': 'MEM', 'Heat': 'MIA',
  'Bucks': 'MIL', 'Timberwolves': 'MIN', 'Pelicans': 'NO', 'Knicks': 'NY',
  'Thunder': 'OKC', 'Magic': 'ORL', '76ers': 'PHI', 'Suns': 'PHX',
  'Trail Blazers': 'POR', 'Kings': 'SAC', 'Spurs': 'SA', 'Raptors': 'TOR',
  'Jazz': 'UTAH', 'Wizards': 'WSH',
}

const MLB_TEAM_BY_NAME: Record<string, string> = {
  'Diamondbacks': 'ARI', 'Braves': 'ATL', 'Orioles': 'BAL', 'Red Sox': 'BOS',
  'Cubs': 'CHC', 'White Sox': 'CHW', 'Reds': 'CIN', 'Guardians': 'CLE',
  'Rockies': 'COL', 'Tigers': 'DET', 'Astros': 'HOU', 'Royals': 'KC',
  'Angels': 'LAA', 'Dodgers': 'LAD', 'Marlins': 'MIA', 'Brewers': 'MIL',
  'Twins': 'MIN', 'Mets': 'NYM', 'Yankees': 'NYY', 'Athletics': 'ATH',
  'Phillies': 'PHI', 'Pirates': 'PIT', 'Padres': 'SD', 'Mariners': 'SEA',
  'Giants': 'SF', 'Cardinals': 'STL', 'Rays': 'TB', 'Rangers': 'TEX',
  'Blue Jays': 'TOR', 'Nationals': 'WSH',
}

const NHL_TEAM_BY_NAME: Record<string, string> = {
  'Ducks': 'ANA', 'Bruins': 'BOS', 'Sabres': 'BUF', 'Flames': 'CGY',
  'Hurricanes': 'CAR', 'Blackhawks': 'CHI', 'Avalanche': 'COL',
  'Blue Jackets': 'CBJ', 'Stars': 'DAL', 'Red Wings': 'DET',
  'Oilers': 'EDM', 'Panthers': 'FLA', 'Kings': 'LA', 'Wild': 'MIN',
  'Canadiens': 'MTL', 'Predators': 'NSH', 'Devils': 'NJ',
  'Islanders': 'NYI', 'Rangers': 'NYR', 'Senators': 'OTT',
  'Flyers': 'PHI', 'Penguins': 'PIT', 'Sharks': 'SJ',
  'Kraken': 'SEA', 'Blues': 'STL', 'Lightning': 'TB',
  'Maple Leafs': 'TOR', 'Mammoth': 'UTA', 'Hockey Club': 'UTA',
  'Canucks': 'VAN', 'Golden Knights': 'VGK', 'Capitals': 'WSH',
  'Jets': 'WPG',
}

const NAME_MAP: Record<Sport, Record<string, string>> = {
  NFL: NFL_TEAM_BY_NAME,
  NBA: NBA_TEAM_BY_NAME,
  MLB: MLB_TEAM_BY_NAME,
  NHL: NHL_TEAM_BY_NAME,
}

export interface PublicBetEntry {
  home_team: string             // canonical abbr
  away_team: string
  kickoff_at: string             // ISO 8601
  public_bets_pct: number | null  // 0..100 — % of tickets on the public side
  public_money_pct: number | null // 0..100 — % of dollars on the public side
  public_side: 'home' | 'away' | null
}

// Parameter shapes from Action Network's response — typed loosely since
// the schema may shift. We only read a handful of fields.
interface AnTeam { full_name?: string; display_name?: string; mascot?: string; abbr?: string }
interface AnConsensusSide { value?: number; pct?: number; tickets?: number; money?: number }
interface AnConsensus { spread?: { home?: AnConsensusSide; away?: AnConsensusSide } }
interface AnGame {
  start_time?: string
  status?: string
  home_team?: AnTeam
  away_team?: AnTeam
  consensus?: AnConsensus
}

export async function fetchPublicBets(sport: Sport, date: Date = new Date()): Promise<PublicBetEntry[]> {
  const yyyymmdd = date.toISOString().slice(0, 10).replace(/-/g, '')
  const url = `https://api.actionnetwork.com/web/v2/scoreboard/${SPORT_PATH[sport]}?bookIds=15&date=${yyyymmdd}`
  let json: { games?: AnGame[] }
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Lila/Ceelo)',
        'accept': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    json = await res.json()
  } catch {
    return []
  }
  const games = Array.isArray(json?.games) ? json.games : []
  const map = NAME_MAP[sport]
  const out: PublicBetEntry[] = []

  for (const g of games) {
    const home = mapTeam(map, g.home_team)
    const away = mapTeam(map, g.away_team)
    if (!home || !away || !g.start_time) continue

    const c = g.consensus?.spread
    const homeBets  = c?.home?.tickets ?? c?.home?.pct ?? null
    const awayBets  = c?.away?.tickets ?? c?.away?.pct ?? null
    const homeMoney = c?.home?.money   ?? null
    const awayMoney = c?.away?.money   ?? null

    let publicSide: 'home' | 'away' | null = null
    let publicBets:  number | null = null
    let publicMoney: number | null = null
    if (homeBets != null && awayBets != null) {
      publicSide  = homeBets >= awayBets ? 'home' : 'away'
      publicBets  = publicSide === 'home' ? homeBets  : awayBets
      publicMoney = publicSide === 'home' ? homeMoney : awayMoney
    }

    out.push({
      home_team: home,
      away_team: away,
      kickoff_at: g.start_time,
      public_bets_pct:  publicBets  != null ? +Number(publicBets).toFixed(2)  : null,
      public_money_pct: publicMoney != null ? +Number(publicMoney).toFixed(2) : null,
      public_side: publicSide,
    })
  }
  return out
}

function mapTeam(map: Record<string, string>, t?: AnTeam): string | null {
  if (!t) return null
  const candidates = [t.mascot, t.display_name, t.full_name, t.abbr].filter(Boolean) as string[]
  for (const c of candidates) {
    if (map[c]) return map[c]
    // Try last-word match as a fallback (e.g. "Los Angeles Lakers" → "Lakers").
    const last = c.split(' ').pop() ?? ''
    if (map[last]) return map[last]
  }
  return null
}
