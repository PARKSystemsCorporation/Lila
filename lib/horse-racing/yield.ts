// Yield engine — derives a single RaceSignal from the runner odds on a
// race. Beta version operates on the retail feed alone; the aggregator
// signature already accepts auxiliary sources so the multi-feed
// consensus version drops in without touching callers.
//
// IMPORTANT: NO LLM calls in this path. All reasoning strings are
// deterministic templates. Mirrors Ceelo's hard rule: model-derived
// picks must be reproducible from inputs alone.

import * as cache from './cache'
import type { Race, RaceSignal, OddsSnapshot, RaceWithSignal } from './types'

const HISTORY_KEY = (raceId: string) => `odds-history:${raceId}`
const HISTORY_TTL_MS = 60 * 60 * 1_000 // keep 1h of snapshots per race

export function calculateYield(race: Race): RaceSignal {
  const runners = race.runners.filter(r => r.odds_decimal != null && r.odds_decimal > 1)
  if (runners.length < 2) {
    return {
      top_runner: null,
      intensity: 1,
      velocity: 'flat',
      reasoning: 'No live prices on the board yet.',
    }
  }

  // Implied probs from decimal odds. Sum exceeds 1 because of the book's
  // overround — normalise to get fair probabilities the book *would* be
  // quoting at zero margin.
  const impliedSum = runners.reduce((s, r) => s + 1 / (r.odds_decimal as number), 0)
  if (impliedSum <= 0) {
    return {
      top_runner: null,
      intensity: 1,
      velocity: 'flat',
      reasoning: 'Odds in the field are degenerate.',
    }
  }

  // For each runner, compute fair_decimal (= 1 / fair_prob). Edge =
  // (fair − book) / book × 100, same formula Ceelo uses on /api/picks.
  // A POSITIVE edge means the book is offering bigger numbers than fair —
  // the value side.
  const scored = runners.map(r => {
    const book = r.odds_decimal as number
    const fairProb = (1 / book) / impliedSum
    const fairDecimal = 1 / fairProb
    const edgePct = ((fairDecimal - book) / book) * 100
    return { runner: r, fairDecimal, edgePct, fairProb }
  })

  // "Top yield" runner = largest positive edge. If all edges are
  // negative (the book overround swamps every runner), fall back to
  // the lowest-overround runner.
  const sortedByEdge = [...scored].sort((a, b) => b.edgePct - a.edgePct)
  const top = sortedByEdge[0]

  // Velocity from the prior odds snapshot for this race. Direction is
  // based on the top-yield runner's price move (shortening = momentum
  // up, drifting = momentum down).
  const history = cache.get<OddsSnapshot[]>(HISTORY_KEY(race.race_id)) ?? []
  const prior = history.length > 0 ? history[history.length - 1] : null
  const priorOdds = prior?.odds[top.runner.horse_id] ?? null
  const velocity = velocityOf(priorOdds, top.runner.odds_decimal)

  // Persist a new snapshot for the next call. Rolling window of 6
  // snapshots (~3 min at our 30s page-poll cadence) is plenty.
  recordSnapshot(race)

  const intensity = intensityFrom(top.edgePct, top.fairProb, race.runners.length)

  return {
    top_runner: {
      horse_id: top.runner.horse_id,
      horse: top.runner.horse,
      number: top.runner.number,
      odds_decimal: top.runner.odds_decimal,
      fair_decimal: round2(top.fairDecimal),
      edge_pct: +top.edgePct.toFixed(1),
      model_prob: +top.fairProb.toFixed(4),
    },
    intensity,
    velocity,
    reasoning: reasoningFor(top, race.runners.length, velocity),
  }
}

function intensityFrom(edgePct: number, fairProb: number, fieldSize: number): number {
  // Edge contributes most of the signal. Calibrated so:
  //   edge ≤ -5%  → intensity 1-2
  //   edge ≈  0%  → intensity 3-4
  //   edge ≈  5%  → intensity 5-6
  //   edge ≈ 15%  → intensity 8
  //   edge ≥ 30%  → intensity 10 (rare, usually means stale odds)
  const edgeComponent = clamp(Math.round(3 + edgePct / 3), 1, 9)
  // Tiny boost when the model thinks the favourite has a meaningful
  // share — keeps 12-runner cards with tiny edges from looking hotter
  // than 5-runner cards with concentrated probability.
  const concentrationBoost = fairProb > 0.4 ? 1 : 0
  // Penalise huge fields (16+) where signal is noisier.
  const sizePenalty = fieldSize >= 16 ? -1 : 0
  return clamp(edgeComponent + concentrationBoost + sizePenalty, 1, 10)
}

function velocityOf(prior: number | null, current: number | null): 'up' | 'down' | 'flat' {
  if (prior == null || current == null) return 'flat'
  const delta = current - prior
  // ~3% odds move threshold — anything smaller is book noise.
  if (Math.abs(delta) / prior < 0.03) return 'flat'
  // Odds shortening (current < prior) = market money coming in = velocity UP.
  return delta < 0 ? 'up' : 'down'
}

function recordSnapshot(race: Race): void {
  const snapshot: OddsSnapshot = {
    race_id: race.race_id,
    taken_at: Date.now(),
    odds: Object.fromEntries(race.runners.map(r => [r.horse_id, r.odds_decimal])),
  }
  const history = cache.get<OddsSnapshot[]>(HISTORY_KEY(race.race_id)) ?? []
  history.push(snapshot)
  while (history.length > 6) history.shift()
  cache.set(HISTORY_KEY(race.race_id), history, HISTORY_TTL_MS)
}

function reasoningFor(
  top: { runner: { horse: string; odds_decimal: number | null }; edgePct: number; fairDecimal: number },
  fieldSize: number,
  velocity: 'up' | 'down' | 'flat',
): string {
  const edge = top.edgePct
  const arrow = velocity === 'up' ? '↑' : velocity === 'down' ? '↓' : '→'
  const direction =
    edge >  3 ? 'value side'
  : edge < -3 ? 'overlay risk'
  : 'fair'
  return `${top.runner.horse} ${arrow} (${edge >= 0 ? '+' : ''}${edge.toFixed(1)}% edge, ${direction}, fair ${top.fairDecimal.toFixed(2)}, ${fieldSize}-runner field).`
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function round2(n: number): number {
  return +n.toFixed(2)
}

// Convenience wrapper used by the API route + loop. Decorates a list of
// races with signals in one call.
export function attachSignals(races: Race[]): RaceWithSignal[] {
  return races.map(r => ({ ...r, signal: calculateYield(r) }))
}
