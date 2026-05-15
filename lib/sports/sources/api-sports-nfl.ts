// Sharp Anchor — API-Sports NFL (Pinnacle / Circa feeds).
// Mirrors the NBA adapter shape (lib/sports/sources/api-sports.ts);
// only the BASE host differs. Returns null on failure so the loop
// continues with the remaining sources.

import type { ApiSportsSnapshot } from './api-sports'

const BASE = process.env.API_SPORTS_NFL_BASE_URL ?? 'https://v1.american-football.api-sports.io'

export async function fetchNflSharpSnapshots(opts: {
  signal?: AbortSignal
} = {}): Promise<ApiSportsSnapshot[] | null> {
  const key = process.env.API_SPORTS_KEY?.trim()
  if (!key) return null

  try {
    const res = await fetch(`${BASE}/games?league=1&season=${currentNflSeason()}`, {
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

// NFL seasons run Sep–Feb of the following calendar year and the
// api-sports.io API keys season on the start year.
function currentNflSeason(): number {
  const now = new Date()
  return now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1
}

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

    const date = typeof r.date === 'string'
      ? r.date
      : (typeof (r.game as { date?: string } | undefined)?.date === 'string'
          ? (r.game as { date: string }).date
          : null)
    if (!date) continue

    const status = mapStatus(extractShortStatus(r))
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

function extractShortStatus(r: Record<string, unknown>): string | undefined {
  const status = r.status as { short?: string } | undefined
  if (status?.short) return status.short
  const game = r.game as { status?: { short?: string } } | undefined
  return game?.status?.short
}

function mapStatus(short: string | undefined): 'scheduled' | 'live' | 'final' {
  if (!short) return 'scheduled'
  if (short === 'FT' || short === 'AOT' || short === 'AET') return 'final'
  if (short === 'NS' || short === 'TBD') return 'scheduled'
  return 'live'
}
