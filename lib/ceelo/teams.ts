// 32 NFL teams. Use ESPN's abbreviation as the canonical key.
// (ESPN uses 2-3 letter codes — same as the popular nflverse encoding.)

export const NFL_TEAMS: ReadonlySet<string> = new Set([
  'ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE',
  'DAL','DEN','DET','GB','HOU','IND','JAX','KC',
  'LAC','LAR','LV','MIA','MIN','NE','NO','NYG',
  'NYJ','PHI','PIT','SEA','SF','TB','TEN','WSH',
])

// ESPN sometimes returns a few legacy/alt abbreviations. Normalize.
const ALIAS: Record<string, string> = {
  WAS: 'WSH',
  JAC: 'JAX',
  LA:  'LAR',  // ambiguous historically — ESPN now uses LAR
  OAK: 'LV',
  SD:  'LAC',
  STL: 'LAR',
}

export function normalizeTeam(abbr: string | null | undefined): string | null {
  if (!abbr) return null
  const up = abbr.toUpperCase().trim()
  const norm = ALIAS[up] ?? up
  return NFL_TEAMS.has(norm) ? norm : null
}
