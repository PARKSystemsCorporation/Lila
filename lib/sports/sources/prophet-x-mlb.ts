// Prediction Market — ProphetX MLB. Same shape as NBA.

import type { ProphetXSnapshot } from './prophet-x'

const BASE = process.env.PROPHET_X_BASE_URL ?? 'https://api.prophetx.co/v1'

export async function fetchMlbPredictionSnapshots(opts: {
  signal?: AbortSignal
} = {}): Promise<ProphetXSnapshot[] | null> {
  const key = process.env.PROPHET_X_KEY?.trim()
  if (!key) return null

  try {
    const res = await fetch(`${BASE}/markets/mlb`, {
      headers: { 'Authorization': `Bearer ${key}` },
      signal: opts.signal,
    })
    if (!res.ok) return null
    const body = await res.json()
    return parseSnapshots(body)
  } catch {
    return null
  }
}

function parseSnapshots(body: unknown): ProphetXSnapshot[] {
  if (!body || typeof body !== 'object') return []
  const markets = (body as { markets?: unknown }).markets
  if (!Array.isArray(markets)) return []

  const out: ProphetXSnapshot[] = []
  for (const raw of markets) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>

    const home = pickTeam(r.home_team), away = pickTeam(r.away_team)
    if (!home || !away) continue

    const probs = r.implied_prob as { home?: number; away?: number } | undefined
    if (!probs || typeof probs.home !== 'number' || typeof probs.away !== 'number') continue
    if (probs.home <= 0 || probs.home > 1 || probs.away <= 0 || probs.away > 1) continue

    const overround_pct = (probs.home + probs.away - 1) * 100

    out.push({
      home_team: home,
      away_team: away,
      implied_prob: { home: probs.home, away: probs.away },
      overround_pct,
      observed_at: typeof r.observed_at === 'string' ? r.observed_at : new Date().toISOString(),
    })
  }
  return out
}

function pickTeam(value: unknown): { city: string; name: string } | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  const city = typeof r.city === 'string' ? r.city : null
  const name = typeof r.name === 'string' ? r.name : null
  if (!city || !name) return null
  return { city, name }
}
