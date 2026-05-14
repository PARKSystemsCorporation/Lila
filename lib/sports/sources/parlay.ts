// Retail Sensor — ParlayAPI (DraftKings / FanDuel / MGM).
// Returns retail prices in cents and ticket/money split percentages.

const BASE = process.env.PARLAY_API_BASE_URL ?? 'https://api.parlay.io/v1'

export type ParlaySnapshot = {
  away_team:        { city: string; name: string }
  home_team:        { city: string; name: string }
  retail_cents:     { home: number; away: number }
  // Ticket and money split percentages (0..100). Used by Whale and
  // Public-Gravity metrics. If the feed omits them, set both to null and
  // the dependent metrics will skip this game-side.
  ticket_pct:       { home: number | null; away: number | null }
  money_pct:        { home: number | null; away: number | null }
  observed_at:      string
}

export async function fetchNbaRetailSnapshots(opts: {
  signal?: AbortSignal
} = {}): Promise<ParlaySnapshot[] | null> {
  const key = process.env.PARLAY_API_KEY?.trim()
  if (!key) return null

  try {
    const res = await fetch(`${BASE}/odds/nba`, {
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

function parseSnapshots(body: unknown): ParlaySnapshot[] {
  if (!body || typeof body !== 'object') return []
  const games = (body as { games?: unknown }).games
  if (!Array.isArray(games)) return []

  const out: ParlaySnapshot[] = []
  for (const raw of games) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>

    const home = pickTeam(r.home_team), away = pickTeam(r.away_team)
    if (!home || !away) continue

    const retail = r.retail_cents as { home?: number; away?: number } | undefined
    if (!retail || typeof retail.home !== 'number' || typeof retail.away !== 'number') continue

    const tickets = r.ticket_pct as { home?: number; away?: number } | undefined
    const money   = r.money_pct  as { home?: number; away?: number } | undefined

    out.push({
      home_team: home,
      away_team: away,
      retail_cents: { home: retail.home, away: retail.away },
      ticket_pct: {
        home: typeof tickets?.home === 'number' ? tickets.home : null,
        away: typeof tickets?.away === 'number' ? tickets.away : null,
      },
      money_pct: {
        home: typeof money?.home === 'number' ? money.home : null,
        away: typeof money?.away === 'number' ? money.away : null,
      },
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
