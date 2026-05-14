// Delta Intensity (the Gap) — retail price minus sharp price.
//   L10  ≥ 0.30  (arbitrage)
//   L9   0.25–0.29
//   L8   0.20–0.24 (yield)
//   L7   0.15–0.19 (core)
//   L6   0.11–0.14
//   L5   0.08–0.10
//   L4   0.05–0.07
//   L1–3 ≤ 0.04 (equilibrium → 1)
// `gap_cents` is signed retail − sharp in dollars. We use the absolute
// magnitude here because either direction creates a yield opportunity.

export type DeltaInputs = { gap_cents: number }

export function deltaScore({ gap_cents }: DeltaInputs): number {
  if (!Number.isFinite(gap_cents)) return 1
  // Round to cents so floating-point noise can't drop a real $0.30 to $0.29(9).
  const g = Math.round(Math.abs(gap_cents) * 100) / 100
  if (g >= 0.30) return 10
  if (g >= 0.25) return 9
  if (g >= 0.20) return 8
  if (g >= 0.15) return 7
  if (g >= 0.11) return 6
  if (g >= 0.08) return 5
  if (g >= 0.05) return 4
  return 1
}
