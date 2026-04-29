import type { Sport } from './teams'

// Elo math for Ceelo's power-ratings model. 538-style: K-factor with a
// margin-of-victory multiplier and a fixed home-field-advantage bias.
//
// Sport-specific tuning:
//   NFL — HFA 55 Elo (~2.2 pts), K 20, 25 Elo per spread point.
//   NBA — HFA 100 Elo (~3.5 pts), K 20, 28 Elo per spread point. Bigger
//         HFA because home court is genuinely more impactful in NBA.
//   MLB — HFA 24 Elo (~0.24 runs), K 4, 10 Elo per run-line point. K is
//         tiny because 162-game seasons are noisy and we don't want any
//         single game to whip the rating around.
//   NHL — HFA 50 Elo (~0.16 goals), K 6, 8 Elo per goal of margin.
//         Hockey-Reference's well-known calibration: 82 games is long
//         enough that K=6 keeps ratings stable while still tracking
//         in-season form.

export const DEFAULT_RATING = 1500

export interface SportConfig {
  HFA: number
  K: number
  ELO_PER_PT: number
}

export const SPORT_CONFIG: Record<Sport, SportConfig> = {
  NFL: { HFA: 55,  K: 20, ELO_PER_PT: 25 },
  NBA: { HFA: 100, K: 20, ELO_PER_PT: 28 },
  MLB: { HFA: 24,  K: 4,  ELO_PER_PT: 10 },
  NHL: { HFA: 50,  K: 6,  ELO_PER_PT: 8  },
}

// Back-compat: NFL constants (callers that haven't been migrated).
export const HFA       = SPORT_CONFIG.NFL.HFA
export const K         = SPORT_CONFIG.NFL.K
export const ELO_PER_PT = SPORT_CONFIG.NFL.ELO_PER_PT

// Win probability given Elo difference (in favor of side A).
export function winProb(eloDiff: number): number {
  return 1 / (1 + Math.pow(10, -eloDiff / 400))
}

// Margin-of-victory multiplier (538's formula). Damp blowout-driven
// rating churn and avoid a feedback loop on already-elite teams.
function movMultiplier(margin: number, eloDiff: number): number {
  const m = Math.abs(margin)
  if (m === 0) return 1
  // eloDiff should be in the direction of the winner (positive when winner had the edge).
  return Math.log(m + 1) * (2.2 / (eloDiff * 0.001 + 2.2))
}

export interface RatingUpdate {
  homeNew: number
  awayNew: number
  homeDelta: number
  awayDelta: number
}

// Apply one game's result to home + away ratings.
// `homeScore > awayScore` ⇒ home won. Sport defaults to NFL for back-compat.
export function applyGame(args: {
  homeRating: number
  awayRating: number
  homeScore: number
  awayScore: number
  neutralSite?: boolean
  sport?: Sport
}): RatingUpdate {
  const { homeRating, awayRating, homeScore, awayScore } = args
  const cfg = SPORT_CONFIG[args.sport ?? 'NFL']
  const hfa = args.neutralSite ? 0 : cfg.HFA

  const expectedHome = winProb(homeRating + hfa - awayRating)
  const margin = homeScore - awayScore
  const actualHome = margin > 0 ? 1 : margin < 0 ? 0 : 0.5

  const winnerEloEdge =
      margin > 0 ? (homeRating + hfa - awayRating)
    : margin < 0 ? (awayRating - homeRating - hfa)
    : 0

  const mult = movMultiplier(margin, winnerEloEdge)
  const delta = cfg.K * mult * (actualHome - expectedHome)

  return {
    homeNew:   +(homeRating + delta).toFixed(3),
    awayNew:   +(awayRating - delta).toFixed(3),
    homeDelta: +delta.toFixed(3),
    awayDelta: +(-delta).toFixed(3),
  }
}

// Compute the model's spread + win-prob for an upcoming game.
// Convention: home spread is negative when home is favored
// (matches sportsbook display).
export interface ModelLine {
  modelSpread: number      // home spread
  modelHomeProb: number    // 0..1 probability home wins outright
}

export function modelLine(args: {
  homeRating: number
  awayRating: number
  neutralSite?: boolean
  sport?: Sport
}): ModelLine {
  const cfg = SPORT_CONFIG[args.sport ?? 'NFL']
  const hfa = args.neutralSite ? 0 : cfg.HFA
  const eloDiff = args.homeRating + hfa - args.awayRating
  return {
    modelSpread:   +(-eloDiff / cfg.ELO_PER_PT).toFixed(2),
    modelHomeProb: +winProb(eloDiff).toFixed(3),
  }
}
