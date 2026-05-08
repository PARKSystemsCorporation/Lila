// Billy Walters point-rating handicapping framework, NFL-only.
//
// Discards Elo. Every input is converted to a numerical point value and the
// Sierra Line (our spread) is built additively from Power Ratings and
// situational adjustments. NBA/MLB still use the Elo path in ratings.ts.
//
// Hard-coded weights from the framework spec — keep them as exported
// constants so the chat layer can surface them to the operator and so
// future operator overrides land in one place.

// ── QB tiers ────────────────────────────────────────────────────────────
//
// Tier 1 (Elite)        7.5 (midpoint of 7-8)
// Tier 2 (High)         5.0 (midpoint of 4-6)
// Tier 3 (Average)      2.5 (midpoint of 2-3)
// Tier 4 (Below Avg)    1.0
// Tier 5 (Backup)       0.0

export const QB_TIER_POINTS: Record<1 | 2 | 3 | 4 | 5, number> = {
  1: 7.5,
  2: 5.0,
  3: 2.5,
  4: 1.0,
  5: 0.0,
}

export type QbTier = 1 | 2 | 3 | 4 | 5

// ── Blue-chip roster weights ────────────────────────────────────────────
//
// Walters cites Wirfs at ~1.3 — we use the midpoint of his 1.3-1.5 OT band.
// Top-tier edge / corner is 0.9 (midpoint of 0.75-1.0). All other positions
// carry zero weight unless the cluster-injury rule fires.

export const BLUE_CHIP_OT_PTS    = 1.4
export const BLUE_CHIP_EDGE_PTS  = 0.9
export const BLUE_CHIP_CB_PTS    = 0.9

// Cluster injury: 3+ starters out in one unit (OL, secondary, etc.)
export const CLUSTER_INJURY_TAX = -1.5

// ── Home Field Advantage ────────────────────────────────────────────────
//
// Historical (1974-2022) average: 2.5. Walters notes HFA is dying, so cap
// modern games (defined here as last 4 yrs) at 1.25 — midpoint of his
// 1.0-1.5 band. The caller decides which window the game falls in.

export const HFA_HISTORICAL = 2.5
export const HFA_MODERN     = 1.25

// ── Situational adjustments ─────────────────────────────────────────────

export const MNF_ROAD_PENALTY        = -0.75   // midpoint of -0.5 to -1.0
export const BLOWOUT_BOUNCEBACK_BONUS = 1.0    // lost previous game by 19+
export const TURF_DISCREPANCY_PENALTY = -0.5   // away on unfamiliar surface

// ── Sierra Line ─────────────────────────────────────────────────────────

export interface SituationalContext {
  // Road team is the away team on Monday night. Penalty applied to away.
  awayIsMnfRoad: boolean
  // Did either team lose their previous game by 19+? Applied as +1.0 to
  // the bouncing-back team's PR.
  homeBounceback: boolean
  awayBounceback: boolean
  // Away team's home stadium uses a different surface than this venue.
  // Applied as -0.5 against the away team.
  awayTurfDiscrepancy: boolean
  // 2024+ — cap HFA at HFA_MODERN. Pre-2024 — use HFA_HISTORICAL.
  modernGame: boolean
  // Neutral site overrides everything HFA-related.
  neutralSite: boolean
}

export interface SierraInputs {
  homePR: number
  awayPR: number
  // Net QB-tier swing for each side. For a healthy starter this is the
  // starter's tier points; if the starter is Out, pass starter_pts -
  // backup_pts so the model sees the swing as a negative.
  homeQbPoints: number
  awayQbPoints: number
  // Net blue-chip points available for each side. Sum tagged players who
  // are NOT on the Out/Doubtful list. Subtract any tagged player who is.
  homeBlueChipPoints: number
  awayBlueChipPoints: number
  // Cluster-injury tax (-1.5 each unit with 3+ starters out, or 0).
  homeClusterTax: number
  awayClusterTax: number
  situational: SituationalContext
}

export interface SierraResult {
  // Raw PR difference (home - away). Positive ⇒ home is the better team.
  rawPrDiff: number
  // Sum of every situational adjustment applied to the spread.
  // Positive ⇒ home line moves further negative (home gets bumped).
  situationalSum: number
  // Walters' "True Line": what we think the spread should be.
  // Convention matches sportsbook display: home spread, negative = home favored.
  sierraLine: number
  // Win probability for the home side.
  homeWinProb: number
  // Itemized log of the adjustments — surfaced to the operator + alerts.
  adjustments: Array<{ label: string; points: number }>
}

// 4-pt-per-spread-point conversion to win probability. This roughly matches
// the historical Pinnacle NFL spread → win-prob mapping (a 7-pt favorite is
// ~75% to win straight up).
export function spreadToWinProb(homeSpread: number): number {
  // Negative home spread (home favored) ⇒ home win prob > 0.5
  return 1 / (1 + Math.pow(10, homeSpread / 16))
}

export function sierraLine(args: SierraInputs): SierraResult {
  const adjustments: Array<{ label: string; points: number }> = []

  // 1. Power-rating diff (already includes blue-chip + QB-tier baselines
  //    rolled into the team's persistent PR — but starter swings, blue-chip
  //    injuries and cluster taxes layer on top).
  const rawPrDiff = +(args.homePR - args.awayPR).toFixed(2)
  adjustments.push({ label: 'Raw PR diff', points: rawPrDiff })

  // 2. QB-tier net (starter healthy = positive; starter Out = starter-backup
  //    delta passed in negative).
  const qbNet = +(args.homeQbPoints - args.awayQbPoints).toFixed(2)
  if (qbNet !== 0) adjustments.push({ label: 'QB tier net', points: qbNet })

  // 3. Blue-chip net.
  const blueChipNet = +(args.homeBlueChipPoints - args.awayBlueChipPoints).toFixed(2)
  if (blueChipNet !== 0) adjustments.push({ label: 'Blue-chip net', points: blueChipNet })

  // 4. Cluster-injury tax — applied per side. Home tax helps away (and vv).
  if (args.homeClusterTax !== 0) {
    adjustments.push({ label: 'Home cluster tax', points: args.homeClusterTax })
  }
  if (args.awayClusterTax !== 0) {
    adjustments.push({ label: 'Away cluster tax', points: -args.awayClusterTax })
  }

  // 5. HFA — neutral site = 0, modern game = capped, else historical.
  const hfa = args.situational.neutralSite
    ? 0
    : args.situational.modernGame ? HFA_MODERN : HFA_HISTORICAL
  if (hfa !== 0) adjustments.push({ label: `HFA (${args.situational.modernGame ? 'modern' : 'historical'})`, points: hfa })

  // 6. Monday-night road penalty — applied to away, so home spread improves.
  if (args.situational.awayIsMnfRoad) {
    adjustments.push({ label: 'MNF road (away)', points: -MNF_ROAD_PENALTY })
  }

  // 7. Blowout bounceback — fires per side independently.
  if (args.situational.homeBounceback) {
    adjustments.push({ label: 'Home bounceback', points: BLOWOUT_BOUNCEBACK_BONUS })
  }
  if (args.situational.awayBounceback) {
    adjustments.push({ label: 'Away bounceback', points: -BLOWOUT_BOUNCEBACK_BONUS })
  }

  // 8. Turf discrepancy — penalizes away.
  if (args.situational.awayTurfDiscrepancy) {
    adjustments.push({ label: 'Turf discrepancy (away)', points: -TURF_DISCREPANCY_PENALTY })
  }

  // Sum every adjustment beyond raw PR diff for the operator-visible block.
  const situationalSum = +adjustments
    .filter(a => a.label !== 'Raw PR diff')
    .reduce((s, a) => s + a.points, 0)
    .toFixed(2)

  // Total swing in home's favor.
  const totalHomeAdvantage = rawPrDiff + situationalSum

  // Sierra Line — book convention: home spread, negative = home favored.
  const sierraLine = +(-totalHomeAdvantage).toFixed(2)
  const homeWinProb = +spreadToWinProb(sierraLine).toFixed(3)

  return { rawPrDiff, situationalSum, sierraLine, homeWinProb, adjustments }
}

// ── Kelly sizing ────────────────────────────────────────────────────────
//
// Quarter-Kelly clamped to 0.5–3.0 units. Walters' "% of edge" maps
// cleanly to the prob-edge formulation: kelly_fraction = (bp - q) / b
// where b = decimal_odds - 1, p = our prob, q = 1 - p.

export function americanToDecimal(odds: number): number {
  if (odds === 0) return 1
  return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds)
}

export function kellyUnits(modelProb: number, americanOdds: number): number {
  const dec = americanToDecimal(americanOdds)
  const b = dec - 1
  if (b <= 0) return 0
  const p = Math.max(0, Math.min(1, modelProb))
  const q = 1 - p
  const fullKelly = (b * p - q) / b
  if (fullKelly <= 0) return 0
  // Quarter-Kelly is the conservative bankroll-preservation choice we
  // commit to here. Each "unit" represents 1% of bankroll, so quarter
  // Kelly × 100 lands in the right scale for the 0.5–3.0 unit range
  // when prob-edge is in the 1-12% band typical of NFL spreads.
  const units = +(fullKelly * 0.25 * 100).toFixed(2)
  return Math.max(0.5, Math.min(3.0, units))
}

// ── PR points-update (used by C1 grading) ───────────────────────────────
//
// Sagarin/Massey-style points update. `expectedMarginHome` comes from the
// closing line (= -home_spread, since home_spread negative ⇒ home favored).
// `trueMarginHome` is the True Score margin for home (after stripping ST
// TDs + late-game garbage).

export const PR_UPDATE_K = 0.25

export interface PrUpdate {
  homeNew: number
  awayNew: number
  homeDelta: number
  awayDelta: number
}

export function applyPrUpdate(args: {
  homePR: number
  awayPR: number
  trueMarginHome: number
  expectedMarginHome: number
}): PrUpdate {
  const surprise = args.trueMarginHome - args.expectedMarginHome
  const delta = +(PR_UPDATE_K * surprise).toFixed(3)
  return {
    homeNew:   +(args.homePR + delta).toFixed(3),
    awayNew:   +(args.awayPR - delta).toFixed(3),
    homeDelta: delta,
    awayDelta: -delta,
  }
}

// PR cold-start — middle-of-the-pack reference point. Walters thinks of
// teams in absolute points (e.g. KC = 23, CAR = 13), centered around 17.
export const DEFAULT_PR = 17.0
