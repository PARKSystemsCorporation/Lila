// Sharp Anchor — API-Sports (Pinnacle / Circa feeds).
// Returns sharp price snapshots (in cents) plus a previous snapshot the
// caller can diff for velocity. Returns null on failure — the ingestion
// loop tolerates a missing source without aborting the others.

const BASE = process.env.API_SPORTS_BASE_URL ?? 'https://v1.basketball.api-sports.io'

export type ApiSportsSnapshot = {
  away_team:      { city: string; name: string }
  home_team:      { city: string; name: string }
  tipoff_at:      string                   // ISO
  status:         'scheduled' | 'live' | 'final'
  pct_game_left:  number | null            // 0..1, null when not live
  // Sharp prices in price-cents (e.g. -110 → 110 against $100 risked, etc.).
  // We carry a paired previous snapshot so the steam metric can diff.
  sharp_cents:    { home: number; away: number }
  prev_sharp_cents: { home: number; away: number; observed_at: string } | null
  observed_at:    string                   // ISO of this snapshot
  // Inputs for the lock metric. fair_value_cents = consensus efficient
  // price; vig_cents = book hold. Both in price-cents.
  fair_value_cents: { home: number; away: number }
  vig_cents:        number
}

export async function fetchNbaSharpSnapshots(opts: {
  signal?: AbortSignal
} = {}): Promise<ApiSportsSnapshot[] | null> {
  const key = process.env.API_SPORTS_KEY?.trim()
  if (!key) return null

  try {
    const res = await fetch(`${BASE}/games?league=12&season=2025-2026`, {
      headers: { 'x-apisports-key': key },
      signal: opts.signal,
    })
    if (!res.ok) return null
    const body = await res.json()
    return parseSnapshots(body)
  } catch {
    return null
  }
}

// Parser is permissive: the upstream schema can shift; if a row lacks the
// fields we care about we drop it silently.
function parseSnapshots(body: unknown): ApiSportsSnapshot[] {
  if (!body || typeof body !== 'object') return []
  const response = (body as { response?: unknown }).response
  if (!Array.isArray(response)) return []

  const out: ApiSportsSnapshot[] = []
  for (const raw of response) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>

    const teams = r.teams as { home?: Record<string, unknown>; away?: Record<string, unknown> } | undefined
    const home = teams?.home, away = teams?.away
    if (!home || !away) continue

    const homeName = pickName(home), awayName = pickName(away)
    if (!homeName || !awayName) continue

    const date = typeof r.date === 'string' ? r.date : null
    if (!date) continue

    const status = mapStatus((r.status as { short?: string } | undefined)?.short)
    const sharp = (r.sharp as { home?: number; away?: number } | undefined) ?? null
    if (!sharp || typeof sharp.home !== 'number' || typeof sharp.away !== 'number') continue

    const prev = (r.prev_sharp as { home?: number; away?: number; observed_at?: string } | undefined) ?? null
    const fair = (r.fair_value as { home?: number; away?: number } | undefined) ?? sharp
    const vig  = typeof r.vig === 'number' ? r.vig : 0

    out.push({
      home_team: homeName,
      away_team: awayName,
      tipoff_at: date,
      status,
      pct_game_left: typeof r.pct_game_left === 'number' ? r.pct_game_left : null,
      sharp_cents: { home: sharp.home, away: sharp.away },
      prev_sharp_cents: prev && typeof prev.home === 'number' && typeof prev.away === 'number' && typeof prev.observed_at === 'string'
        ? { home: prev.home, away: prev.away, observed_at: prev.observed_at }
        : null,
      observed_at: typeof r.observed_at === 'string' ? r.observed_at : new Date().toISOString(),
      fair_value_cents: { home: fair.home ?? sharp.home, away: fair.away ?? sharp.away },
      vig_cents: vig,
    })
  }
  return out
}

function pickName(team: Record<string, unknown>): { city: string; name: string } | null {
  const city = typeof team.city === 'string' ? team.city : (typeof team.location === 'string' ? team.location : null)
  const name = typeof team.name === 'string' ? team.name : (typeof team.nickname === 'string' ? team.nickname : null)
  if (!city || !name) return null
  return { city, name }
}

function mapStatus(short: string | undefined): 'scheduled' | 'live' | 'final' {
  if (!short) return 'scheduled'
  if (short === 'FT' || short === 'AOT') return 'final'
  if (short === 'NS' || short === 'TBD') return 'scheduled'
  return 'live'
}
