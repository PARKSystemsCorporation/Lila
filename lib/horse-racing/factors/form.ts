// Recency-weighted form score derived from the form string the Racing
// API ships on each entry (e.g. "1-2-3-P-4" with the most recent finish
// LEFT-most). Returns 1..10 or null when no parseable history exists.
//
// Mapping per character:
//   '1' → 10, '2' → 9, '3' → 8, '4' → 7, '5' → 6,
//   '6' → 5,  '7' → 4, '8' → 3, '9' → 2,
//   '0' (DNF marker), 'P' (pulled up), 'F' (fell),
//   'U' (unseated), 'R' (refused), 'B' (brought down) → 1
//
// We weight the last 5 finishes 0.40, 0.25, 0.15, 0.12, 0.08 so the
// freshest start dominates without being the only signal.

const WEIGHTS = [0.40, 0.25, 0.15, 0.12, 0.08]

function scoreChar(c: string): number | null {
  if (c >= '1' && c <= '9') return 11 - Number(c)
  if (c === '0' || c === 'P' || c === 'F' || c === 'U' || c === 'R' || c === 'B') return 1
  return null
}

export function formScore(form: string | null | undefined): number | null {
  if (!form) return null
  const chars = form.toUpperCase().replace(/[^0-9A-Z]/g, '')
  if (!chars) return null

  let total = 0
  let weight = 0
  for (let i = 0; i < Math.min(chars.length, WEIGHTS.length); i++) {
    const s = scoreChar(chars[i])
    if (s == null) continue
    total += WEIGHTS[i] * s
    weight += WEIGHTS[i]
  }
  if (weight === 0) return null
  const score = total / weight
  return clamp(Math.round(score), 1, 10)
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
