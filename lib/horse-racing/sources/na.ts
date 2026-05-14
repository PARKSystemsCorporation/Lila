// North America (US + CAN) source for The Racing API. Mirrors the UK
// surface in racing-api.ts but speaks the NA meet/entries vocabulary:
//
//     MEET                                       one track, one date
//       ├── race 1  (race_number=1)
//       │     └── entries[]   (one per runner)
//       ├── race 2
//       │     └── entries[]
//       └── …
//
// All entry rows for one meet land in a single `entries` payload, so we
// cache per meet (one HTTP call per track per refresh window) instead of
// per race. On a 10-track Saturday that's 10 calls / refresh, not ~100.
//
// Inferred field names follow the FastAPI operationId
// `meet_entries_v1_north_america_meets__meet_id__entries_get` shared by
// the operator. Real-world drift is absorbed by the same `?? fallback`
// pattern used in racing-api.ts — if a key arrives under a different
// name, add it to the chain.

import { enqueue } from '../rate-limiter'
import * as cache from '../cache'
import type { Race, RaceResult, Runner } from '../types'
import { fractionalToDecimal, numOrNull, strOrNull } from '../util'

const DEFAULT_BASE = 'https://api.theracingapi.com'
const TTL_MEETS_MS   = 5 * 60 * 1_000      // 5 min — meet list changes slowly
const TTL_ENTRIES_MS = 45 * 1_000          // 45 s — odds drift inside entries
const TTL_RESULTS_MS = 24 * 60 * 60 * 1_000 // 24 h — final results don't change

// ── Track allow-list + timezones ─────────────────────────────────────────
// Scope v1 to the meets with deep books and consistent fields. Widen by
// adding a row — every new entry needs a track_id (key) and an IANA
// timezone (for off_time rendering).

const TRACK_TZ: Record<string, string> = {
  AQU: 'America/New_York',          // Aqueduct
  BEL: 'America/New_York',          // Belmont
  SAR: 'America/New_York',          // Saratoga
  CD:  'America/Kentucky/Louisville', // Churchill Downs
  KEE: 'America/Kentucky/Louisville', // Keeneland
  GP:  'America/New_York',          // Gulfstream Park
  TAM: 'America/New_York',          // Tampa Bay Downs
  OP:  'America/Chicago',           // Oaklawn Park
  FG:  'America/Chicago',           // Fair Grounds
  SA:  'America/Los_Angeles',       // Santa Anita
  DMR: 'America/Los_Angeles',       // Del Mar
  GG:  'America/Los_Angeles',       // Golden Gate
  WO:  'America/Toronto',           // Woodbine (CAN)
}

export const TOP_TRACKS: ReadonlySet<string> = new Set(Object.keys(TRACK_TZ))

function trackTimezone(track_id: string): string {
  return TRACK_TZ[track_id] ?? 'America/New_York'
}

// ── HTTP plumbing ────────────────────────────────────────────────────────

let warnedNoCreds = false

function getCreds(): { user: string; pass: string } | null {
  const user = process.env.RACING_API_USERNAME
  const pass = process.env.RACING_API_PASSWORD
  if (!user || !pass) {
    if (!warnedNoCreds) {
      console.warn('[horse-racing/na] RACING_API_USERNAME / RACING_API_PASSWORD not set — NA feed will return empty.')
      warnedNoCreds = true
    }
    return null
  }
  return { user, pass }
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
        console.warn(`[horse-racing/na] ${path} → HTTP ${r.status}`)
        return null
      }
      return (await r.json()) as T
    } catch (e) {
      console.warn(`[horse-racing/na] ${path} failed:`, e)
      return null
    }
  })
}

// ── Public types ─────────────────────────────────────────────────────────

export interface MeetSummary {
  meet_id: string
  track_id: string
  track_name: string
  date: string                          // 'YYYY-MM-DD' (track-local)
  country: string                       // 'USA' | 'CAN' | other ISO3
  num_races: number | null
  first_race_off_dt: string | null      // ISO timestamp (UTC) of race 1
}

// ── Synthetic race_id helpers ────────────────────────────────────────────
// race_id = `${meet_id}:${race_number}` lets every downstream consumer
// (DB primary key, ceelo_results, ceelo_picks) keep its existing TEXT
// race_id column — no schema migration for the ID itself. Round-trip
// via parseNaRaceId() to fetch back the parent meet.

export function naRaceId(meet_id: string, race_number: number | string): string {
  return `${meet_id}:${race_number}`
}

export function parseNaRaceId(race_id: string): { meet_id: string; race_number: number } | null {
  const m = race_id.match(/^(.+):(\d+)$/)
  if (!m) return null
  const rn = parseInt(m[2], 10)
  if (!Number.isFinite(rn)) return null
  return { meet_id: m[1], race_number: rn }
}

// ── Normalisers ──────────────────────────────────────────────────────────

function normaliseMeet(raw: Record<string, unknown>): MeetSummary | null {
  const meet_id = strOrNull(raw.meet_id ?? raw.id)
  const track_id = strOrNull(raw.track_id ?? raw.track ?? raw.code)
  if (!meet_id || !track_id) return null
  return {
    meet_id,
    track_id,
    track_name: strOrNull(raw.track_name ?? raw.track) ?? track_id,
    date: strOrNull(raw.date) ?? todayKey(),
    country: strOrNull(raw.country) ?? 'USA',
    num_races: numOrNull(raw.num_races ?? raw.race_count),
    first_race_off_dt: strOrNull(raw.first_race_off_dt ?? raw.first_off_dt ?? raw.off_dt),
  }
}

// Per-entry odds. NA returns morning lines as fractional ("5-2"); live
// odds when available arrive as decimal under a handful of names.
function pickNAOdds(raw: Record<string, unknown>): number | null {
  const direct = numOrNull(
    raw.live_odds_decimal
      ?? raw.odds_decimal
      ?? raw.decimal_odds
      ?? raw.morning_line_decimal,
  )
  if (direct != null && direct > 1) return direct

  const oddsArr = raw.odds as Array<Record<string, unknown>> | undefined
  if (Array.isArray(oddsArr) && oddsArr.length > 0) {
    const candidates = oddsArr
      .map(o => numOrNull(o.decimal ?? o.fractional_decimal))
      .filter((v): v is number => v != null && Number.isFinite(v) && v > 1)
    if (candidates.length > 0) {
      const sorted = [...candidates].sort((a, b) => a - b)
      return sorted[Math.floor(sorted.length / 2)]
    }
  }

  return fractionalToDecimal(raw.morning_line ?? raw.ml)
}

function normaliseEntry(raw: Record<string, unknown>): Runner | null {
  const horse_id = strOrNull(raw.horse_id ?? raw.id)
  if (!horse_id) return null
  return {
    horse_id,
    horse:        strOrNull(raw.horse ?? raw.name) ?? '',
    number:       strOrNull(raw.program_number ?? raw.number ?? raw.pp),
    draw:         numOrNull(raw.post_position ?? raw.draw ?? raw.pp),
    jockey:       strOrNull(raw.jockey),
    trainer:      strOrNull(raw.trainer),
    age:          numOrNull(raw.age),
    weight_lbs:   numOrNull(raw.weight_lbs ?? raw.weight ?? raw.lbs),
    form:         strOrNull(raw.form),
    odds_decimal: pickNAOdds(raw),
  }
}

// Render an ISO timestamp in the track's local timezone as "HH:MM".
function localOffTime(isoDt: string, tz: string): string {
  if (!isoDt) return ''
  const d = new Date(isoDt)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: tz,
    }).format(d)
  } catch {
    return d.toISOString().slice(11, 16)
  }
}

interface NARaceRaw {
  race_number?: number | string
  number?: number | string
  off_dt?: string
  off_time?: string
  race_name?: string
  name?: string
  distance?: string
  distance_f?: string
  surface?: string
  going?: string
  race_type?: string
  type?: string
  purse?: number
  entries?: Array<Record<string, unknown>>
  runners?: Array<Record<string, unknown>>
}

function normaliseNARace(
  raw: NARaceRaw,
  meet: { meet_id: string; track_name: string; country: string; tz: string },
): Race | null {
  const race_number = numOrNull(raw.race_number ?? raw.number)
  if (race_number == null) return null

  const entriesRaw = raw.entries ?? raw.runners ?? []
  const runners = entriesRaw
    .map(normaliseEntry)
    .filter((r): r is Runner => r != null)

  const off_dt = strOrNull(raw.off_dt) ?? ''
  const off_time = strOrNull(raw.off_time)
    ?? (off_dt ? localOffTime(off_dt, meet.tz) : '')

  return {
    race_id:   naRaceId(meet.meet_id, race_number),
    course:    meet.track_name,
    country:   meet.country,
    off_time,
    off_dt,
    race_name: strOrNull(raw.race_name ?? raw.name) ?? `Race ${race_number}`,
    distance:  strOrNull(raw.distance ?? raw.distance_f),
    going:     strOrNull(raw.surface ?? raw.going),
    type:      strOrNull(raw.race_type ?? raw.type),
    field_size: runners.length,
    runners,
  }
}

// ── Public API ───────────────────────────────────────────────────────────

// List today's NA meets, filtered through TOP_TRACKS. Pass a YYYY-MM-DD
// date string to override "today" (caller's responsibility to pick a
// timezone-appropriate date; the API itself is date-keyed).
export async function listTodayMeets(date?: string): Promise<MeetSummary[]> {
  const d = date ?? todayKey()
  return cache.memo(`na:meets:${d}`, TTL_MEETS_MS, async () => {
    const payload = await fetchJson<Record<string, unknown>>(
      `/v1/north_america/meets?start_date=${encodeURIComponent(d)}&end_date=${encodeURIComponent(d)}`,
    )
    if (!payload) return []
    const list = (payload.meets as Record<string, unknown>[])
      ?? (payload.data as Record<string, unknown>[])
      ?? []
    return list
      .map(normaliseMeet)
      .filter((m): m is MeetSummary => m != null && TOP_TRACKS.has(m.track_id))
  })
}

// One meet's full entry payload. Flattens into one Race per race_number
// — every race on the card shares the cache hit.
export async function getMeetEntries(meet_id: string): Promise<Race[]> {
  if (!meet_id) return []
  return cache.memo(`na:entries:${meet_id}`, TTL_ENTRIES_MS, async () => {
    const payload = await fetchJson<Record<string, unknown>>(
      `/v1/north_america/meets/${encodeURIComponent(meet_id)}/entries`,
    )
    if (!payload) return []
    const track_id = strOrNull(payload.track_id ?? payload.track ?? payload.code) ?? ''
    const meet = {
      meet_id,
      track_name: strOrNull(payload.track_name ?? payload.track) ?? track_id,
      country:    strOrNull(payload.country) ?? 'USA',
      tz:         trackTimezone(track_id),
    }
    const racesRaw = (payload.races as NARaceRaw[])
      ?? (payload.entries as NARaceRaw[])
      ?? []
    return racesRaw
      .map(r => normaliseNARace(r, meet))
      .filter((r): r is Race => r != null && r.race_id !== '')
  })
}

// One meet's results — one row per race that's been graded. Caller filters
// by race_id to find the one it cares about.
export async function getMeetResults(meet_id: string): Promise<RaceResult[]> {
  if (!meet_id) return []
  return cache.memo(`na:results:${meet_id}`, TTL_RESULTS_MS, async () => {
    const payload = await fetchJson<Record<string, unknown>>(
      `/v1/north_america/meets/${encodeURIComponent(meet_id)}/results`,
    )
    if (!payload) return []
    const racesRaw = (payload.races as Array<Record<string, unknown>>)
      ?? (payload.results as Array<Record<string, unknown>>)
      ?? []
    return racesRaw
      .map(r => normaliseMeetResult(r, meet_id))
      .filter((r): r is RaceResult => r != null)
  })
}

function normaliseMeetResult(
  raw: Record<string, unknown>,
  meet_id: string,
): RaceResult | null {
  const race_number = numOrNull(raw.race_number ?? raw.number)
  if (race_number == null) return null
  const finishersRaw = (raw.finishers as Array<Record<string, unknown>>)
    ?? (raw.runners as Array<Record<string, unknown>>)
    ?? []
  return {
    race_id: naRaceId(meet_id, race_number),
    finished_at: strOrNull(raw.finished_at ?? raw.off_dt) ?? new Date().toISOString(),
    finishers: finishersRaw
      .map(f => ({
        horse_id: strOrNull(f.horse_id ?? f.id) ?? '',
        horse:    strOrNull(f.horse ?? f.name) ?? '',
        position: numOrNull(f.position) ?? 0,
        sp_decimal: numOrNull(f.sp_decimal ?? f.sp ?? f.win_payout_decimal),
      }))
      .filter(f => f.horse_id && f.position > 0)
      .sort((a, b) => a.position - b.position),
  }
}

function todayKey(): string {
  // UTC date — meets are paged by day server-side. The API treats date as
  // the meet's local calendar day; UTC is a safe default and is what every
  // other module in this codebase uses for `today`.
  return new Date().toISOString().slice(0, 10)
}
