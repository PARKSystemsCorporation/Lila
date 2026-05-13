// Heuristic Bets%/Money% derivation from FanDuel line movement. Used by
// /api/viewer/scoreboard while the public-betting scraper isn't wired in.
// Swap this single function when the real feed lands.
//
// The book typically moves the line against the popular side. A bigger move
// implies a bigger public skew. We cap the magnitude at 3 points so blowout
// moves don't pin the dial.

export interface PublicSplit {
  bets_pct:  number       // 50–90
  money_pct: number       // 50–85 (money is usually a tighter band)
  popular_side: 'home' | 'away' | 'over' | 'under'
}

// Spread move: home_line going more negative = book pushed against home
// favorite, meaning the public is loading on home. Going more positive =
// public is on the away side.
export function spreadSplitFromMove(open: number | null, current: number | null): PublicSplit | null {
  if (open == null || current == null) return null
  const move = current - open
  if (move === 0) return null
  return {
    ...pctBands(Math.abs(move)),
    popular_side: move < 0 ? 'home' : 'away',
  }
}

// Total move: total going up = public on over (book lifts to discourage it);
// total going down = public on under.
export function totalSplitFromMove(open: number | null, current: number | null): PublicSplit | null {
  if (open == null || current == null) return null
  const move = current - open
  if (move === 0) return null
  return {
    ...pctBands(Math.abs(move)),
    popular_side: move > 0 ? 'over' : 'under',
  }
}

function pctBands(mag: number) {
  const capped = Math.min(mag, 3)
  const bets   = Math.round(50 + (capped / 3) * 40)  // 50 → 90
  const money  = Math.round(50 + (capped / 3) * 35)  // 50 → 85
  return { bets_pct: bets, money_pct: money }
}
