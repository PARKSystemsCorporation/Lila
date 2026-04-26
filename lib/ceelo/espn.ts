import { normalizeTeam } from './teams'

// ESPN's numeric team IDs — needed for the per-team endpoints (rosters,
// injuries). Map of canonical 2-3 letter abbr → ESPN id.
export const ESPN_TEAM_ID: Record<string, number> = {
  ARI: 22, ATL: 1,  BAL: 33, BUF: 2,  CAR: 29, CHI: 3,  CIN: 4,  CLE: 5,
  DAL: 6,  DEN: 7,  DET: 8,  GB:  9,  HOU: 34, IND: 11, JAX: 30, KC:  12,
  LAC: 24, LAR: 14, LV:  13, MIA: 15, MIN: 16, NE:  17, NO:  18, NYG: 19,
  NYJ: 20, PHI: 21, PIT: 23, SEA: 26, SF:  25, TB:  27, TEN: 10, WSH: 28,
}

export interface InjuryEntry {
  team: string         // canonical abbr
  player: string
  position: string | null
  status: string | null      // 'Out' | 'Questionable' | 'Doubtful' | 'IR' | 'Active' | etc.
  description: string | null
}

// Pull current injury report for a single team. Free + no-auth.
export async function fetchTeamInjuries(team: string): Promise<InjuryEntry[]> {
  const id = ESPN_TEAM_ID[team]
  if (!id) return []
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${id}/injuries`
  const res = await fetch(url, { headers: { 'user-agent': 'Lila/Ceelo' } })
  if (!res.ok) return []
  const json = await res.json()
  const items: unknown[] = Array.isArray(json?.injuries) ? json.injuries : []

  const out: InjuryEntry[] = []
  for (const itemRaw of items) {
    const it = itemRaw as Record<string, unknown>
    // ESPN nests injuries inside { team, injuries: [...] } per team chunk —
    // for the per-team endpoint there's typically just one entry. Handle both.
    const subList: unknown[] = Array.isArray(it.injuries) ? (it.injuries as unknown[]) : [it]
    for (const subRaw of subList) {
      const s = subRaw as Record<string, unknown>
      const ath = s.athlete as Record<string, unknown> | undefined
      const player = (ath?.displayName as string) ?? (ath?.fullName as string) ?? ''
      if (!player) continue
      const position = ((ath?.position as Record<string, unknown>)?.abbreviation as string) ?? null
      const status = (s.status as string) ?? null
      const details = s.details as Record<string, unknown> | undefined
      const detailType = (details?.type as string) ?? ''
      const detailDetail = (details?.detail as string) ?? ''
      const description = [detailType, detailDetail].filter(Boolean).join(' — ') || null
      out.push({ team, player, position, status, description })
    }
  }
  return out
}

// ESPN's public scoreboard endpoint. Free, no auth, JSON.
//   https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard
//
// Default returns the current week's scoreboard. With a `dates` query
// param we can pull ranges (YYYYMMDD or YYYYMMDD-YYYYMMDD) and with
// `seasontype` + `week` + `dates=YYYY` we can pull a specific season-week.

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'

export interface EspnGame {
  espn_id: string
  season: number              // e.g. 2025
  week: number | null
  season_type: number         // 1=preseason, 2=regular, 3=postseason
  home_team: string           // canonical abbr
  away_team: string
  kickoff_at: string          // ISO 8601
  status: 'scheduled' | 'in_progress' | 'final' | 'postponed'
  home_score: number | null
  away_score: number | null
  neutral_site: boolean
}

export async function fetchCurrent(): Promise<EspnGame[]> {
  return fetchScoreboard(BASE)
}

export async function fetchSeasonWeek(season: number, seasonType: number, week: number): Promise<EspnGame[]> {
  const url = `${BASE}?seasontype=${seasonType}&week=${week}&dates=${season}`
  return fetchScoreboard(url)
}

async function fetchScoreboard(url: string): Promise<EspnGame[]> {
  const res = await fetch(url, { headers: { 'user-agent': 'Lila/Ceelo' } })
  if (!res.ok) throw new Error(`ESPN scoreboard ${res.status}`)
  const json = await res.json()
  const events: unknown[] = Array.isArray(json?.events) ? json.events : []
  return events.map(parseEvent).filter((g): g is EspnGame => g !== null)
}

function parseEvent(raw: unknown): EspnGame | null {
  const e = raw as Record<string, unknown>
  const espn_id = String(e?.id ?? '')
  if (!espn_id) return null

  const season = (e?.season as { year?: number })?.year ?? 0
  const seasonType = (e?.season as { type?: number })?.type ?? 2
  const week = (e?.week as { number?: number })?.number ?? null

  const competitions = Array.isArray(e?.competitions) ? (e.competitions as unknown[]) : []
  const comp = competitions[0] as Record<string, unknown> | undefined
  if (!comp) return null

  const competitors = Array.isArray(comp.competitors) ? (comp.competitors as unknown[]) : []
  if (competitors.length !== 2) return null

  let home: { abbr: string; score: number | null } | null = null
  let away: { abbr: string; score: number | null } | null = null
  for (const cRaw of competitors) {
    const c = cRaw as Record<string, unknown>
    const team = c.team as Record<string, unknown> | undefined
    const abbr = normalizeTeam(team?.abbreviation as string | undefined)
    if (!abbr) return null
    const scoreStr = c.score
    const score = scoreStr != null && scoreStr !== '' ? Number(scoreStr) : null
    const slot = { abbr, score: Number.isFinite(score) ? score : null }
    if (c.homeAway === 'home') home = slot
    else if (c.homeAway === 'away') away = slot
  }
  if (!home || !away) return null

  const kickoff_at = (e?.date as string) ?? ''
  if (!kickoff_at) return null

  const statusRaw = (e?.status as Record<string, unknown>)?.type as Record<string, unknown> | undefined
  const stateStr = (statusRaw?.state as string) ?? 'pre'
  const completed = Boolean(statusRaw?.completed)
  const status: EspnGame['status'] =
      completed              ? 'final'
    : stateStr === 'in'      ? 'in_progress'
    : stateStr === 'post'    ? 'final'
    : (statusRaw?.name as string) === 'STATUS_POSTPONED' ? 'postponed'
    : 'scheduled'

  const neutral_site = Boolean(comp.neutralSite)

  return {
    espn_id,
    season,
    week,
    season_type: seasonType,
    home_team: home.abbr,
    away_team: away.abbr,
    kickoff_at,
    status,
    home_score: home.score,
    away_score: away.score,
    neutral_site,
  }
}
