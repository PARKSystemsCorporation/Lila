// Weighted blend of the per-metric 1–10 scores into a single composite
// that drives the color tier. Weights live in one named constant so the
// operator can tune them without hunting through the codebase.
import { clampScore } from '../scale'

export const COMPOSITE_WEIGHTS = {
  overround:      1.0,
  consensus:      0.8,
  steam:          1.4,   // velocity is high-signal — slightly over-weighted
  delta:          1.4,   // the gap is the core yield trigger
  public_gravity: 0.6,
  whale:          0.8,
  lead_pct:       0.6,   // only meaningful for live games
  sma10:          0.6,   // momentum — only meaningful after history exists
  lock:           1.0,
}

export type CompositeInputs = Partial<Record<keyof typeof COMPOSITE_WEIGHTS, number | null>>

export function compositeScore(inputs: CompositeInputs): number {
  let weighted = 0
  let totalWeight = 0
  for (const key of Object.keys(COMPOSITE_WEIGHTS) as Array<keyof typeof COMPOSITE_WEIGHTS>) {
    const value = inputs[key]
    if (value == null || !Number.isFinite(value)) continue
    const w = COMPOSITE_WEIGHTS[key]
    weighted    += value * w
    totalWeight += w
  }
  if (totalWeight === 0) return 1
  return clampScore(weighted / totalWeight)
}
