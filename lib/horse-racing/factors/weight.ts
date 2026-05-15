// Weight-carried modifier: z-score the runner's weight_lbs against the
// field median; lower weight = better score. Map z ∈ [-2, +2] linearly
// onto score [9, 3], then clamp to [1, 10]. Null when the runner has no
// weight on the card or the field has no positive weight data.
//
// Rationale: in NA & UK racing the lightest-weighted horses get a
// measurable real edge per pound on race day. The signal is small and
// shouldn't dominate the model, hence the modest weight in the
// composite blend.

import type { Runner } from '../types'

export function weightScore(runner: Runner, field: Runner[]): number | null {
  if (runner.weight_lbs == null) return null
  const weights = field.map(r => r.weight_lbs).filter((w): w is number => w != null && w > 0)
  if (weights.length < 2) return null

  const median = sortedMedian(weights)
  // Population stdev across the field. Cheap; field sizes are small.
  const variance = weights.reduce((s, w) => s + (w - median) ** 2, 0) / weights.length
  const stdev = Math.sqrt(variance)
  if (stdev === 0) return null

  const z = (runner.weight_lbs - median) / stdev
  // Lower weight → higher score. Map z=-2 → 9, z=0 → 6, z=+2 → 3.
  const score = 6 - 1.5 * z
  return clamp(Math.round(score), 1, 10)
}

function sortedMedian(values: number[]): number {
  const v = [...values].sort((a, b) => a - b)
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
