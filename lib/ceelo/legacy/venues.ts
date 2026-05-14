// NFL home stadium surface map. Used by Walters' turf-discrepancy
// adjustment: if the away team's home stadium uses a different surface
// than this game's venue, apply -0.5 against the away team.
//
// Each entry is the team's HOME stadium surface (as of the 2024 season).
// "grass" = natural; "turf" = any artificial (FieldTurf, Matrix, AstroTurf).
//
// Source — current as of late-2024 NFL season:
//   https://en.wikipedia.org/wiki/List_of_current_National_Football_League_stadiums
// If a team relocates or installs a new field, update here.

export type Surface = 'grass' | 'turf'

export const NFL_HOME_SURFACE: Record<string, Surface> = {
  ARI: 'grass',  // State Farm Stadium (retractable natural grass)
  ATL: 'turf',   // Mercedes-Benz Stadium
  BAL: 'grass',  // M&T Bank Stadium
  BUF: 'turf',   // Highmark Stadium
  CAR: 'grass',  // Bank of America Stadium
  CHI: 'grass',  // Soldier Field
  CIN: 'turf',   // Paycor Stadium
  CLE: 'grass',  // Cleveland Browns Stadium
  DAL: 'turf',   // AT&T Stadium
  DEN: 'grass',  // Empower Field at Mile High
  DET: 'turf',   // Ford Field
  GB:  'grass',  // Lambeau Field
  HOU: 'turf',   // NRG Stadium
  IND: 'turf',   // Lucas Oil Stadium
  JAX: 'grass',  // EverBank Stadium
  KC:  'grass',  // Arrowhead Stadium
  LAC: 'grass',  // SoFi Stadium
  LAR: 'grass',  // SoFi Stadium
  LV:  'grass',  // Allegiant Stadium (retractable tray)
  MIA: 'grass',  // Hard Rock Stadium
  MIN: 'turf',   // U.S. Bank Stadium
  NE:  'turf',   // Gillette Stadium
  NO:  'turf',   // Caesars Superdome
  NYG: 'turf',   // MetLife Stadium
  NYJ: 'turf',   // MetLife Stadium
  PHI: 'grass',  // Lincoln Financial Field
  PIT: 'grass',  // Acrisure Stadium
  SEA: 'turf',   // Lumen Field
  SF:  'grass',  // Levi's Stadium
  TB:  'grass',  // Raymond James Stadium
  TEN: 'grass',  // Nissan Stadium
  WSH: 'grass',  // Northwest Stadium
}

// Surface of the venue this game is played in (= home team's stadium
// unless this is a neutral-site / international game; we don't model
// neutral-site venues separately yet, so home team's surface stands in).
export function venueSurface(homeTeam: string): Surface | null {
  return NFL_HOME_SURFACE[homeTeam] ?? null
}

// Walters' turf-discrepancy fires when the away team's HOME surface differs
// from the venue surface. Returns true when we should apply the -0.5 tax.
export function awayTurfDiscrepancy(args: {
  homeTeam: string
  awayTeam: string
}): boolean {
  const venue = NFL_HOME_SURFACE[args.homeTeam]
  const awayHome = NFL_HOME_SURFACE[args.awayTeam]
  if (!venue || !awayHome) return false
  return venue !== awayHome
}
