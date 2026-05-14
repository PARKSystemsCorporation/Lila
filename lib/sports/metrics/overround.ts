// 1–10 from ProphetX overround. Every 10 percentage points = one tier.
// 1–10% → 1, 11–20% → 2, …, 91–100% → 10. Values ≤0 collapse to 1.
import { clampScore } from '../scale'

export type OverroundInputs = { overround_pct: number }

export function overroundScore({ overround_pct }: OverroundInputs): number {
  if (!Number.isFinite(overround_pct) || overround_pct <= 0) return 1
  return clampScore(Math.ceil(overround_pct / 10))
}
