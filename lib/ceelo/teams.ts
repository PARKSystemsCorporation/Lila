// Team registries per sport. ESPN abbreviations are the canonical key —
// they're the same codes the major data providers (nflverse for NFL,
// 538 / basketball-reference for NBA, retrosheet / Lahman for MLB) use.

export type Sport = 'NFL' | 'NBA' | 'MLB'

export const NFL_TEAMS: ReadonlySet<string> = new Set([
  'ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE',
  'DAL','DEN','DET','GB','HOU','IND','JAX','KC',
  'LAC','LAR','LV','MIA','MIN','NE','NO','NYG',
  'NYJ','PHI','PIT','SEA','SF','TB','TEN','WSH',
])

export const NBA_TEAMS: ReadonlySet<string> = new Set([
  'ATL','BOS','BKN','CHA','CHI','CLE','DAL','DEN',
  'DET','GS','HOU','IND','LAC','LAL','MEM','MIA',
  'MIL','MIN','NO','NY','OKC','ORL','PHI','PHX',
  'POR','SAC','SA','TOR','UTAH','WSH',
])

export const MLB_TEAMS: ReadonlySet<string> = new Set([
  'ARI','ATL','BAL','BOS','CHC','CHW','CIN','CLE',
  'COL','DET','HOU','KC','LAA','LAD','MIA','MIL',
  'MIN','NYM','NYY','OAK','PHI','PIT','SD','SEA',
  'SF','STL','TB','TEX','TOR','WSH','ATH',
])

const NFL_ALIAS: Record<string, string> = {
  WAS: 'WSH', JAC: 'JAX', LA: 'LAR', OAK: 'LV', SD: 'LAC', STL: 'LAR',
}
const NBA_ALIAS: Record<string, string> = {
  // ESPN sometimes uses GSW / NOP / NYK / SAS / UTA / PHO
  GSW:  'GS',
  NOP:  'NO',
  NYK:  'NY',
  SAS:  'SA',
  UTA:  'UTAH',
  PHO:  'PHX',
  BRK:  'BKN',
}
const MLB_ALIAS: Record<string, string> = {
  WAS: 'WSH', WSN: 'WSH',
  CWS: 'CHW', CHA: 'CHW',
  TBR: 'TB', TBA: 'TB',
  CHN: 'CHC',
  KCR: 'KC',
  SDP: 'SD', SFG: 'SF',
  SLN: 'STL',
  ANA: 'LAA',
  // ESPN now uses 'ATH' for Athletics (Sacramento). Older feeds: OAK.
}

const SPORT_REGISTRY: Record<Sport, { teams: ReadonlySet<string>; alias: Record<string, string> }> = {
  NFL: { teams: NFL_TEAMS, alias: NFL_ALIAS },
  NBA: { teams: NBA_TEAMS, alias: NBA_ALIAS },
  MLB: { teams: MLB_TEAMS, alias: MLB_ALIAS },
}

// Sport-aware normalize. Pass the sport so abbr collisions like LAC
// (NFL Chargers vs NBA Clippers) resolve to the right team.
export function normalizeTeamFor(sport: Sport, abbr: string | null | undefined): string | null {
  if (!abbr) return null
  const up = abbr.toUpperCase().trim()
  const reg = SPORT_REGISTRY[sport]
  const norm = reg.alias[up] ?? up
  return reg.teams.has(norm) ? norm : null
}

// Back-compat: NFL-only normalize (callers that haven't been updated).
export function normalizeTeam(abbr: string | null | undefined): string | null {
  return normalizeTeamFor('NFL', abbr)
}

export const ALL_SPORTS: Sport[] = ['NFL', 'NBA', 'MLB']
