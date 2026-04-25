// Elo math for Ceelo's NFL power-ratings model.
//
// 538-style: K-factor with a margin-of-victory multiplier and a fixed
// home-field-advantage bias. Single rating per team (no offense/defense
// splits in v2 — those would need EPA data we're not ingesting yet).
//
// Conversion: ~25 Elo points = 1 spread point. So a 100-point rating gap
// translates to roughly a 4-point favorite.

export const HFA       = 55     // home-field advantage in Elo points (~2.2 spread points)
export const K         = 20     // base K-factor
export const ELO_PER_PT = 25    // Elo points per 1 spread point
export const DEFAULT_RATING = 1500

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
// `homeScore > awayScore` ⇒ home won.
export function applyGame(args: {
  homeRating: number
  awayRating: number
  homeScore: number
  awayScore: number
  neutralSite?: boolean
}): RatingUpdate {
  const { homeRating, awayRating, homeScore, awayScore } = args
  const hfa = args.neutralSite ? 0 : HFA

  const expectedHome = winProb(homeRating + hfa - awayRating)
  const margin = homeScore - awayScore
  const actualHome = margin > 0 ? 1 : margin < 0 ? 0 : 0.5

  // Elo diff in winner's favor for the MOV multiplier.
  const winnerEloEdge =
      margin > 0 ? (homeRating + hfa - awayRating)
    : margin < 0 ? (awayRating - homeRating - hfa)
    : 0

  const mult = movMultiplier(margin, winnerEloEdge)
  const delta = K * mult * (actualHome - expectedHome)

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
}): ModelLine {
  const hfa = args.neutralSite ? 0 : HFA
  const eloDiff = args.homeRating + hfa - args.awayRating  // positive = home favored
  return {
    modelSpread:   +(-eloDiff / ELO_PER_PT).toFixed(2),
    modelHomeProb: +winProb(eloDiff).toFixed(3),
  }
}
