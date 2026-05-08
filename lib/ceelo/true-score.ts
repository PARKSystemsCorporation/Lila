import { ESPN_TEAM_ID } from './espn'

// Walters strips garbage-time and lucky-bounce points before updating his
// power ratings — the "True Score." Without per-play win-prob we approximate:
//
//   1. Drop kickoff/punt/INT/fumble-return TDs (the "lucky bounce" bucket).
//   2. Drop any score after the leader was up 17+ in Q4 with < 8 min left
//      (the "garbage time" bucket — proxy for win-prob > 95%).
//
// Both filters are deliberate over-simplifications. Walters' ground truth
// would use PFF / EPA-margin per drive; we don't pay for that. The aim
// here is to keep one bad break from ricocheting through Ceelo's PR
// updates for the rest of the season.

const ESPN_ID_TO_ABBR: Record<number, string> = (() => {
  const out: Record<number, string> = {}
  for (const [abbr, id] of Object.entries(ESPN_TEAM_ID)) out[id] = abbr
  return out
})()

export interface ScoringPlay {
  team: string                   // canonical abbr
  period: number                 // 1..4 (5+ = OT)
  clockSec: number | null        // seconds remaining in period
  pointsAdded: number            // delta vs prior scoreboard (XPs included)
  text: string                   // ESPN's descriptive text
  homeScoreAfter: number
  awayScoreAfter: number
}

export interface TrueScoreResult {
  homeRaw: number
  awayRaw: number
  homeTrue: number
  awayTrue: number
  stripped: Array<{ team: string; pointsAdded: number; reason: string; text: string }>
}

const SUMMARY_URL = (espnId: string) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${espnId}`

export async function fetchScoringSummary(espnId: string, homeTeam: string, awayTeam: string): Promise<{
  plays: ScoringPlay[]
  finalHome: number | null
  finalAway: number | null
} | null> {
  const res = await fetch(SUMMARY_URL(espnId), {
    headers: { 'user-agent': 'Lila/Ceelo' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) return null
  const json = await res.json() as Record<string, unknown>

  const rawPlays = Array.isArray(json.scoringPlays) ? json.scoringPlays as unknown[] : []
  const plays: ScoringPlay[] = []
  let lastHome = 0
  let lastAway = 0

  for (const pRaw of rawPlays) {
    const p = pRaw as Record<string, unknown>
    const team = p.team as Record<string, unknown> | undefined
    const teamId = Number((team?.id as string | number | undefined))
    const teamAbbr =
      ESPN_ID_TO_ABBR[teamId] ??
      ((team?.abbreviation as string | undefined) ?? '').toUpperCase()
    if (teamAbbr !== homeTeam && teamAbbr !== awayTeam) continue

    const homeScore = Number(p.homeScore ?? 0)
    const awayScore = Number(p.awayScore ?? 0)
    const period = Number((p.period as Record<string, unknown> | undefined)?.number ?? 0) || 0
    const clockRaw = (p.clock as Record<string, unknown> | undefined)?.displayValue as string | undefined
    const clockSec = parseClock(clockRaw)
    const text = String(p.text ?? '')

    const pointsAdded =
      teamAbbr === homeTeam ? Math.max(0, homeScore - lastHome) : Math.max(0, awayScore - lastAway)

    plays.push({
      team: teamAbbr,
      period,
      clockSec,
      pointsAdded,
      text,
      homeScoreAfter: homeScore,
      awayScoreAfter: awayScore,
    })
    lastHome = homeScore
    lastAway = awayScore
  }

  return { plays, finalHome: lastHome, finalAway: lastAway }
}

function parseClock(disp: string | undefined): number | null {
  if (!disp) return null
  const m = disp.match(/^(\d+):(\d+)$/)
  if (!m) return null
  const min = parseInt(m[1], 10)
  const sec = parseInt(m[2], 10)
  if (!Number.isFinite(min) || !Number.isFinite(sec)) return null
  return min * 60 + sec
}

// Special-teams or lucky-recovery TD: returned for a score off a kickoff,
// punt, interception, or fumble. ESPN encodes this in `text`, e.g.
// "Devin Hester 92 yard kickoff return for a touchdown".
const RETURN_TD_PATTERNS = [
  /kickoff return/i,
  /punt return/i,
  /interception return/i,
  /fumble return/i,
  /\breturn(?:ed)?\b.*touchdown/i,
  /\bblocked (?:punt|field goal)\b.*touchdown/i,
]

function isReturnTd(p: ScoringPlay): boolean {
  // Only filter actual TDs (6+ pts) — XPs / FGs that follow stay.
  if (p.pointsAdded < 6) return false
  return RETURN_TD_PATTERNS.some(re => re.test(p.text))
}

// Garbage time: leader is up 17+ entering this play, in Q4, with less
// than 8 minutes (480s) remaining. Score from either side is excluded.
function isGarbage(p: ScoringPlay, prevHome: number, prevAway: number): boolean {
  if (p.period < 4) return false
  if (p.clockSec == null || p.clockSec > 8 * 60) return false
  const leaderMargin = Math.abs(prevHome - prevAway)
  return leaderMargin >= 17
}

export function trueScore(args: {
  plays: ScoringPlay[]
  homeTeam: string
  awayTeam: string
  finalHome: number
  finalAway: number
}): TrueScoreResult {
  let homeTrue = 0
  let awayTrue = 0
  let prevHome = 0
  let prevAway = 0
  const stripped: TrueScoreResult['stripped'] = []

  for (const p of args.plays) {
    const reason =
        isReturnTd(p) ? 'special-teams / return TD'
      : isGarbage(p, prevHome, prevAway) ? 'garbage time (Q4, lead ≥17, <8min)'
      : null

    if (reason) {
      stripped.push({ team: p.team, pointsAdded: p.pointsAdded, reason, text: p.text })
    } else if (p.team === args.homeTeam) {
      homeTrue += p.pointsAdded
    } else if (p.team === args.awayTeam) {
      awayTrue += p.pointsAdded
    }

    prevHome = p.homeScoreAfter
    prevAway = p.awayScoreAfter
  }

  // If we never saw any plays (offseason / unsupported game), fall back to
  // the box-score final so callers still get a usable margin.
  if (args.plays.length === 0) {
    homeTrue = args.finalHome
    awayTrue = args.finalAway
  }

  return {
    homeRaw: args.finalHome,
    awayRaw: args.finalAway,
    homeTrue,
    awayTrue,
    stripped,
  }
}
