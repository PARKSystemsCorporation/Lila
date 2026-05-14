// The Racing API adapter. Free tier: 1 RPS, HTTP Basic auth.
// Docs: https://www.theracingapi.com/documentation
//
// All callers route through enqueue() (1 RPS limiter) + memo() (TTL cache).
// Missing creds → returns empty results + a single warn on cold start
// instead of throwing. This matches Ceelo's Odds.isConfigured() pattern:
// a missing upstream should never crash the agent tick.
//
// Region router — the public surface is stable but the implementation
// branches on RACING_API_REGION ('NA' default, 'UK' fallback). NA goes
// to lib/horse-racing/sources/na.ts (meet/entries vocabulary); UK keeps
// the per-race /v1/racecards/{id} surface intact for emergency fallback.

import { enqueue } from './rate-limiter'
import * as cache from './cache'
import type { Race, RaceResult, Runner } from './types'
import { fractionalToDecimal, numOrNull, strOrNull } from './util'
import * as na from './sources/na'

const DEFAULT_BASE = 'https://api.theracingapi.com'
const TTL_CARDS_MS   = 5 * 60 * 1_000      // 5 min — daily card changes slowly
const TTL_ODDS_MS    = 45 * 1_000          // 45 s  — drift refresh
const TTL_RESULTS_MS = 24 * 60 * 60 * 1_000 // 24 h — results are final

type Region = 'NA' | 'UK'
function region(): Region {
  const v = (process.env.RACING_API_REGION ?? 'NA').toUpperCase()
  return v === 'UK' ? 'UK' : 'NA'
}

let warnedNoCreds = false

function getCreds(): { user: string; pass: string } | null {
  const user = process.env.RACING_API_USERNAME
  const pass = process.env.RACING_API_PASSWORD
  if (!user || !pass) {
    if (!warnedNoCreds) {
      console.warn('[horse-racing] RACING_API_USERNAME / RACING_API_PASSWORD not set — racing data feed will return empty.')
      warnedNoCreds = true
    }
    return null
  }
  return { user, pass }
}

export function isConfigured(): boolean {
  return Boolean(process.env.RACING_API_USERNAME && process.env.RACING_API_PASSWORD)
}

export function getRegion(): Region {
  return region()
}

function authHeader(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
}

async function fetchJson<T>(path: string): Promise<T | null> {
  const creds = getCreds()
  if (!creds) return null
  const base = process.env.RACING_API_BASE_URL || DEFAULT_BASE
  const url = `${base}${path}`

  return enqueue(async () => {
    try {
      const r = await fetch(url, {
        headers: {
          Authorization: authHeader(creds.user, creds.pass),
          Accept: 'application/json',
        },
        cache: 'no-store',
      })
      if (!r.ok) {
        console.warn(`[horse-racing] ${path} → HTTP ${r.status}`)
        return null
      }
      return (await r.json()) as T
    } catch (e) {
      console.warn(`[horse-racing] ${path} failed:`, e)
      return null
    }
  })
}

// ── UK normalisers ────────────────────────────────────────────────────────
// The free vs pro racecards endpoints return slightly different shapes;
// we coerce both into our internal Race type and tolerate missing fields.

function normaliseRunner(raw: Record<string, unknown>): Runner {
  const odds = pickOdds(raw)
  return {
    horse_id: String(raw.horse_id ?? raw.id ?? ''),
    horse:    String(raw.horse ?? raw.name ?? ''),
    number:   strOrNull(raw.number ?? raw.cloth_number),
    draw:     numOrNull(raw.draw ?? raw.stall),
    jockey:   strOrNull(raw.jockey),
    trainer:  strOrNull(raw.trainer),
    age:      numOrNull(raw.age),
    weight_lbs: numOrNull(raw.lbs ?? raw.weight_lbs),
    form:     strOrNull(raw.form),
    odds_decimal: odds,
  }
}

function normaliseRace(raw: Record<string, unknown>): Race {
  const runnersRaw = (raw.runners as Record<string, unknown>[]) ?? []
  const runners = runnersRaw.map(normaliseRunner)
  return {
    race_id:   String(raw.race_id ?? raw.id ?? ''),
    course:    String(raw.course ?? raw.venue ?? ''),
    country:   null,
    off_time:  String(raw.off_time ?? raw.off ?? ''),
    off_dt:    String(raw.off_dt ?? raw.off_time_iso ?? ''),
    race_name: String(raw.race_name ?? raw.name ?? ''),
    distance:  strOrNull(raw.distance ?? raw.dist ?? raw.distance_f),
    going:     strOrNull(raw.going),
    type:      strOrNull(raw.type ?? raw.race_class),
    field_size: runners.length,
    runners,
  }
}

// Racing API embeds odds in different fields depending on tier. Try the
// common ones in order; fall back to null if none are present (free tier
// often only ships forecast/SP info on basic racecards).
function pickOdds(raw: Record<string, unknown>): number | null {
  const oddsArr = raw.odds as Array<Record<string, unknown>> | undefined
  if (Array.isArray(oddsArr) && oddsArr.length > 0) {
    const candidates = oddsArr
      .map(o => numOrNull(o.decimal ?? o.fractional_decimal))
      .filter((v): v is number => v != null && Number.isFinite(v) && v > 1)
    if (candidates.length > 0) {
      // Use the median to dampen one-off outlier books.
      const sorted = [...candidates].sort((a, b) => a - b)
      return sorted[Math.floor(sorted.length / 2)]
    }
  }
  // Direct fields seen on some endpoints.
  const direct = numOrNull(raw.odds_decimal ?? raw.decimal_odds ?? raw.forecast_decimal)
  if (direct != null) return direct
  // SP forecast as fraction "9/2" → decimal.
  return fractionalToDecimal(raw.sp ?? raw.forecast)
}

// ── Public API ────────────────────────────────────────────────────────────

export async function getTodayRacecards(): Promise<Race[]> {
  if (region() === 'NA') {
    const meets = await na.listTodayMeets()
    const all: Race[] = []
    for (const m of meets) {
      const races = await na.getMeetEntries(m.meet_id).catch(() => [])
      all.push(...races)
    }
    return all
  }
  // ── UK fallback ──
  const path = process.env.RACING_API_RACECARDS_PATH || '/v1/racecards/basic'
  return cache.memo(`cards:${path}:${todayKey()}`, TTL_CARDS_MS, async () => {
    const payload = await fetchJson<Record<string, unknown>>(path)
    if (!payload) return []
    const list = (payload.racecards as Record<string, unknown>[])
      ?? (payload.races as Record<string, unknown>[])
      ?? []
    return list.map(normaliseRace).filter(r => r.race_id)
  })
}

export async function getRacecard(raceId: string): Promise<Race | null> {
  if (!raceId) return null
  if (region() === 'NA') {
    const parsed = na.parseNaRaceId(raceId)
    if (!parsed) return null
    const races = await na.getMeetEntries(parsed.meet_id).catch(() => [])
    return races.find(r => r.race_id === raceId) ?? null
  }
  // ── UK fallback ──
  return cache.memo(`card:${raceId}`, TTL_ODDS_MS, async () => {
    const payload = await fetchJson<Record<string, unknown>>(`/v1/racecards/${encodeURIComponent(raceId)}`)
    if (!payload) return null
    return normaliseRace(payload)
  })
}

export async function getResult(raceId: string): Promise<RaceResult | null> {
  if (!raceId) return null
  if (region() === 'NA') {
    const parsed = na.parseNaRaceId(raceId)
    if (!parsed) return null
    const results = await na.getMeetResults(parsed.meet_id).catch(() => [])
    return results.find(r => r.race_id === raceId) ?? null
  }
  // ── UK fallback ──
  return cache.memo(`result:${raceId}`, TTL_RESULTS_MS, async () => {
    const payload = await fetchJson<Record<string, unknown>>(`/v1/results/${encodeURIComponent(raceId)}`)
    if (!payload) return null
    const finishersRaw = (payload.runners as Record<string, unknown>[])
      ?? (payload.finishers as Record<string, unknown>[])
      ?? []
    return {
      race_id: String(payload.race_id ?? raceId),
      finished_at: String(payload.finished_at ?? payload.off_dt ?? new Date().toISOString()),
      finishers: finishersRaw
        .map(r => ({
          horse_id: String(r.horse_id ?? r.id ?? ''),
          horse: String(r.horse ?? r.name ?? ''),
          position: numOrNull(r.position) ?? 0,
          sp_decimal: numOrNull(r.sp_decimal ?? r.sp ?? null),
        }))
        .filter(f => f.horse_id && f.position > 0)
        .sort((a, b) => a.position - b.position),
    }
  })
}

// Region-aware meet listing for diagnostics. NA returns the live meet
// list; UK returns an empty array (UK doesn't surface a meet vocabulary
// in our adapter — it's per-race).
export async function listTodayMeets() {
  if (region() === 'NA') return na.listTodayMeets()
  return []
}

export function cacheSize(): number {
  return cache.size()
}

function todayKey(): string {
  // UTC date — racecards are paged by day server-side.
  return new Date().toISOString().slice(0, 10)
}
