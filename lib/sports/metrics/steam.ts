// Steam Intensity (Velocity) — sharp-line movement over ≤2 minutes.
// Operator's tier table, in price-cents:
//   L10  ≥ 0.25  (solar flare)
//   L9   0.15–0.24
//   L8   0.10–0.14
//   L7   0.07–0.09     (action threshold)
//   L6   0.05–0.06
//   L5   0.03–0.04
//   L4   0.02
//   L1–3 ≤ 0.01 (noise — collapsed to 1)
// `delta_cents` is the absolute shift in dollars (e.g. 0.27 for $0.27).

export type SteamInputs = {
  delta_cents:   number          // absolute, in dollars ($0.27 = 0.27)
  elapsed_ms:    number          // time between snapshots
}

export function steamScore({ delta_cents, elapsed_ms }: SteamInputs): number {
  if (!Number.isFinite(delta_cents) || !Number.isFinite(elapsed_ms)) return 1
  if (elapsed_ms > 120_000) return 1   // velocity window is ≤ 2 min
  const d = Math.abs(delta_cents)
  if (d >= 0.25) return 10
  if (d >= 0.15) return 9
  if (d >= 0.10) return 8
  if (d >= 0.07) return 7
  if (d >= 0.05) return 6
  if (d >= 0.03) return 5
  if (d >= 0.02) return 4
  return 1
}
