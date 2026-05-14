// Small shared helpers for racing-api.ts + sources/na.ts. Kept here so
// the UK and NA normalisers don't drift apart on coercion behaviour.

export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

export function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s ? s : null
}

// Parse a fractional-odds string ("9/2", "5-2") to decimal (e.g. 5.5, 3.5).
// Returns null for anything that doesn't match. NA morning lines arrive as
// "5-2"; UK SP forecasts as "9/2"; both reduce to the same math.
export function fractionalToDecimal(raw: unknown): number | null {
  const s = strOrNull(raw)
  if (!s) return null
  const m = s.match(/^(\d+)\s*[\/-]\s*(\d+)$/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  const d = parseInt(m[2], 10)
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null
  return +(n / d + 1).toFixed(2)
}
