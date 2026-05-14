// Public Gravity — the 'pull' of retail bias. Magnitude of the parlay-line
// vs. api-sports-line gap. Same tier ladder as Delta but applied to raw line
// units (cents) rather than price-cents. Inputs already in dollar units.

export type PublicGravityInputs = {
  parlay_line:     number
  api_sports_line: number
}

export function publicGravityScore({ parlay_line, api_sports_line }: PublicGravityInputs): number {
  if (!Number.isFinite(parlay_line) || !Number.isFinite(api_sports_line)) return 1
  const pull = Math.round(Math.abs(parlay_line - api_sports_line) * 100) / 100
  if (pull >= 0.30) return 10
  if (pull >= 0.25) return 9
  if (pull >= 0.20) return 8
  if (pull >= 0.15) return 7
  if (pull >= 0.11) return 6
  if (pull >= 0.08) return 5
  if (pull >= 0.05) return 4
  return 1
}
