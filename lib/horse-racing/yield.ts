// Yield engine — derives a single RaceSignal from the runner odds on a
// race. Beta version operates on the retail feed alone; the aggregator
// signature already accepts auxiliary sources so the multi-feed
// consensus version drops in without touching callers.
//
// IMPORTANT: NO LLM calls in this path. All reasoning strings are
// deterministic templates. Mirrors Ceelo's hard rule: model-derived
// picks must be reproducible from inputs alone.

import * as cache from './cache'
import type { Race, Runner, RaceSignal, OddsSnapshot, RaceWithSignal } from './types'
import type { SourceQuotes } from './sources/types'

const HISTORY_KEY = (raceId: string) => `odds-history:${raceId}`
const HISTORY_TTL_MS = 60 * 60 * 1_000 // keep 1h of snapshots per race

// Source-kind blend weights when fusing the auxiliary feeds with the
// retail board. Sharp dominates because Pinnacle / Betfair Exchange
// last-traded prices are the closest the public market gets to true.
const KIND_WEIGHT: Record<'sharp' | 'retail' | 'prediction', number> = {
  sharp: 0.50,
  retail: 0.30,
  prediction: 0.20,
}

export function calculateYield(race: Race, aux: SourceQuotes[] = []): RaceSignal {
  const runners = race.runners.filter(r => r.odds_decimal != null && r.odds_decimal > 1)
  if (runners.length < 2) {
    return {
      top_runner: null,
      intensity: 1,
      velocity: 'flat',
      reasoning: 'No live prices on the board yet.',
    }
  }

  // Blended fair probabilities across retail + aux sources. When `aux`
  // is empty this falls back to the legacy retail-overround-normalised
  // probability (mathematically identical to the previous behaviour).
  const blended = blendImpliedProbs(runners, aux)
  if (!blended || blended.size === 0) {
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
    const fairProb = blended.get(r.horse_id) ?? null
    const fairDecimal = fairProb && fairProb > 0 ? 1 / fairProb : Number.POSITIVE_INFINITY
    const edgePct = Number.isFinite(fairDecimal) ? ((fairDecimal - book) / book) * 100 : 0
    return { runner: r, fairDecimal, edgePct, fairProb: fairProb ?? 0 }
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
// races with signals in one call. Optional per-race aux quotes are
// keyed by race_id.
export function attachSignals(
  races: Race[],
  aux: Record<string, SourceQuotes[]> = {},
): RaceWithSignal[] {
  return races.map(r => ({ ...r, signal: calculateYield(r, aux[r.race_id] ?? []) }))
}

// ─── Multi-source fair-probability blend ──────────────────────────────────

// Blend implied probabilities across the retail board and any auxiliary
// source quotes by weighted average. Weights are per-source-kind (sharp
// > retail > prediction), renormalised over the sources that actually
// have a quote for a given runner. The output is a probability map
// (horse_id → fair_prob) that sums to ~1 over priced runners.
//
// Pure function with no side effects — fully unit-testable.
export function blendImpliedProbs(
  runners: Runner[],
  aux: SourceQuotes[],
): Map<string, number> | null {
  // Start with retail-derived implied probs from the board.
  const retailSum = runners.reduce((s, r) => s + 1 / (r.odds_decimal as number), 0)
  if (retailSum <= 0) return null

  // Per-horse aggregator: weighted sum of probs and total weight applied.
  const acc = new Map<string, { sum: number; weight: number }>()
  for (const r of runners) {
    const book = r.odds_decimal as number
    const retailProb = (1 / book) / retailSum
    const w = KIND_WEIGHT.retail
    acc.set(r.horse_id, { sum: retailProb * w, weight: w })
  }

  // Layer each aux source on top. Source probabilities are normalised
  // within the source first so an overround inside the aux feed doesn't
  // leak through.
  for (const src of aux) {
    if (!src || !src.quotes) continue
    const kind = src.source.includes('sharp') ? 'sharp'
              : src.source.includes('pred')  ? 'prediction'
              : src.source.includes('retail') || src.source.includes('racingapi') ? 'retail'
              : 'retail'
    const weight = KIND_WEIGHT[kind]

    let srcSum = 0
    const srcProbs = new Map<string, number>()
    for (const r of runners) {
      const q = src.quotes[r.horse_id]
      if (!q) continue
      let p: number | null = null
      if (q.implied_prob != null && q.implied_prob > 0) {
        p = q.implied_prob
      } else if (q.odds_decimal != null && q.odds_decimal > 1) {
        p = 1 / q.odds_decimal
      }
      if (p == null || !Number.isFinite(p) || p <= 0) continue
      srcProbs.set(r.horse_id, p)
      srcSum += p
    }
    if (srcSum <= 0) continue

    for (const [horseId, p] of srcProbs) {
      const norm = p / srcSum
      const entry = acc.get(horseId) ?? { sum: 0, weight: 0 }
      entry.sum    += norm * weight
      entry.weight += weight
      acc.set(horseId, entry)
    }
  }

  const out = new Map<string, number>()
  for (const [horseId, { sum, weight }] of acc) {
    if (weight <= 0) continue
    out.set(horseId, sum / weight)
  }
  // Renormalise so the blended probabilities sum to 1 over priced
  // runners — preserves the "fair prob" semantics callers depend on.
  const total = [...out.values()].reduce((s, p) => s + p, 0)
  if (total <= 0) return null
  for (const [horseId, p] of out) out.set(horseId, p / total)
  return out
}

// ─── Per-runner scoring exported for the public landing preview ───────────

export interface RunnerScore {
  horse_id: string
  horse: string
  number: string | null
  jockey: string | null
  trainer: string | null
  odds_decimal: number | null
  fair_decimal: number | null
  edge_pct: number | null
  fair_prob: number | null
  edge_component:    number | null
  form_component:    number | null
  weight_component:  number | null
  draw_component:    number | null
  jockey_component:  number | null
  trainer_component: number | null
  composite_score: number
  reasoning: string
}

// Weights used in the composite blend. Order: edge, form, weight, draw,
// jockey, trainer. Components that are null contribute 0 weight so the
// remaining factors renormalise correctly.
const COMPONENT_WEIGHTS = {
  edge:    0.55,
  form:    0.15,
  weight:  0.10,
  draw:    0.05,
  jockey:  0.10,
  trainer: 0.05,
} as const

// Returns per-runner scores for every horse on the card. Priced runners
// are sorted by composite_score desc; unpriced runners trail with
// composite=1 and null edge components.
//
// `extras` carries the precomputed factor scores from the modifier
// modules — keeping I/O (jockey/trainer DB lookups) at the call site
// makes this function synchronous and easily testable.
export function scoreAllRunners(
  race: Race,
  aux: SourceQuotes[] = [],
  extras: Partial<Record<string, {
    form?:    number | null
    weight?:  number | null
    draw?:    number | null
    jockey?:  number | null
    trainer?: number | null
  }>> = {},
): RunnerScore[] {
  const priced = race.runners.filter(r => r.odds_decimal != null && r.odds_decimal > 1)
  const unpriced = race.runners.filter(r => !priced.includes(r))

  const blended = priced.length >= 2 ? blendImpliedProbs(priced, aux) : null

  const scored: RunnerScore[] = priced.map(r => {
    const book = r.odds_decimal as number
    const fairProb = blended?.get(r.horse_id) ?? null
    const fairDecimal = fairProb && fairProb > 0 ? +(1 / fairProb).toFixed(2) : null
    const edgePct = fairDecimal != null ? +((fairDecimal - book) / book * 100).toFixed(1) : null

    const edgeComponent = edgePct != null
      ? clamp(Math.round(3 + edgePct / 3), 1, 10)
      : null

    const ex = extras[r.horse_id] ?? {}
    const composite = blendComposite({
      edge:    edgeComponent,
      form:    ex.form ?? null,
      weight:  ex.weight ?? null,
      draw:    ex.draw ?? null,
      jockey:  ex.jockey ?? null,
      trainer: ex.trainer ?? null,
    })

    return {
      horse_id: r.horse_id,
      horse: r.horse,
      number: r.number,
      jockey: r.jockey,
      trainer: r.trainer,
      odds_decimal: book,
      fair_decimal: fairDecimal,
      edge_pct: edgePct,
      fair_prob: fairProb != null ? +fairProb.toFixed(4) : null,
      edge_component:    edgeComponent,
      form_component:    ex.form ?? null,
      weight_component:  ex.weight ?? null,
      draw_component:    ex.draw ?? null,
      jockey_component:  ex.jockey ?? null,
      trainer_component: ex.trainer ?? null,
      composite_score: composite,
      reasoning: reasoningForRunner(r.horse, edgePct, composite),
    }
  })

  scored.sort((a, b) => b.composite_score - a.composite_score)

  const trailing: RunnerScore[] = unpriced.map(r => ({
    horse_id: r.horse_id,
    horse: r.horse,
    number: r.number,
    jockey: r.jockey,
    trainer: r.trainer,
    odds_decimal: null,
    fair_decimal: null,
    edge_pct: null,
    fair_prob: null,
    edge_component: null,
    form_component: null,
    weight_component: null,
    draw_component: null,
    jockey_component: null,
    trainer_component: null,
    composite_score: 1,
    reasoning: 'No live price on the board yet.',
  }))

  return [...scored, ...trailing]
}

function blendComposite(c: {
  edge: number | null
  form: number | null
  weight: number | null
  draw: number | null
  jockey: number | null
  trainer: number | null
}): number {
  let total = 0
  let weight = 0
  if (c.edge    != null) { total += COMPONENT_WEIGHTS.edge    * c.edge;    weight += COMPONENT_WEIGHTS.edge }
  if (c.form    != null) { total += COMPONENT_WEIGHTS.form    * c.form;    weight += COMPONENT_WEIGHTS.form }
  if (c.weight  != null) { total += COMPONENT_WEIGHTS.weight  * c.weight;  weight += COMPONENT_WEIGHTS.weight }
  if (c.draw    != null) { total += COMPONENT_WEIGHTS.draw    * c.draw;    weight += COMPONENT_WEIGHTS.draw }
  if (c.jockey  != null) { total += COMPONENT_WEIGHTS.jockey  * c.jockey;  weight += COMPONENT_WEIGHTS.jockey }
  if (c.trainer != null) { total += COMPONENT_WEIGHTS.trainer * c.trainer; weight += COMPONENT_WEIGHTS.trainer }
  if (weight === 0) return 1
  return clamp(Math.round(total / weight), 1, 10)
}

function reasoningForRunner(horse: string, edgePct: number | null, composite: number): string {
  if (edgePct == null) return `${horse}: no live price.`
  const direction =
    edgePct >  3 ? 'value side'
  : edgePct < -3 ? 'overlay risk'
  : 'fair'
  const sign = edgePct >= 0 ? '+' : ''
  return `${horse}: composite ${composite}/10 (${sign}${edgePct.toFixed(1)}% edge, ${direction}).`
}
