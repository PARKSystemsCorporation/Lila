// Approximate league regular-season + playoff windows. The user-facing
// "% of season remaining" is computed against the regular-season window
// only; once playoffs hit, we surface a 'playoffs' phase instead.

export type SportKey = 'NFL' | 'NBA' | 'NHL' | 'MLB'
export type SeasonPhase = 'regular' | 'playoffs' | 'offseason'

export interface SeasonState {
  sport: SportKey
  label: string
  phase: SeasonPhase
  pctRemaining: number | null
  daysRemaining: number | null
  next: { phase: SeasonPhase; on: string } | null
}

interface Window { regStart: [number, number]; regEnd: [number, number]; playoffEnd: [number, number] }

const SCHEDULE: Record<SportKey, Window> = {
  NFL: { regStart: [9, 5],  regEnd: [1, 8],  playoffEnd: [2, 14] },
  NBA: { regStart: [10, 22], regEnd: [4, 13], playoffEnd: [6, 22] },
  NHL: { regStart: [10, 8],  regEnd: [4, 18], playoffEnd: [6, 25] },
  MLB: { regStart: [3, 27], regEnd: [9, 28], playoffEnd: [11, 5] },
}

function dateForYear(year: number, mmdd: [number, number]): Date {
  return new Date(Date.UTC(year, mmdd[0] - 1, mmdd[1]))
}

function pickWindow(sport: SportKey, today: Date): { regStart: Date; regEnd: Date; playoffEnd: Date } {
  const w = SCHEDULE[sport]
  const y = today.getUTCFullYear()
  const startsLastYear = w.regStart[0] > w.regEnd[0]
  let startYear = startsLastYear ? y - 1 : y
  let endYear = y
  if (startsLastYear) {
    const startThisCycle = dateForYear(y, w.regStart)
    if (today >= startThisCycle) { startYear = y; endYear = y + 1 }
  } else {
    const endThisYear = dateForYear(y, w.playoffEnd)
    if (today > endThisYear) { startYear = y + 1; endYear = y + 1 }
  }
  return {
    regStart:   dateForYear(startYear, w.regStart),
    regEnd:     dateForYear(endYear,   w.regEnd),
    playoffEnd: dateForYear(endYear,   w.playoffEnd),
  }
}

const LABEL: Record<SportKey, string> = { NFL: 'NFL', NBA: 'NBA', NHL: 'NHL', MLB: 'MLB' }

export function seasonStateFor(sport: SportKey, today = new Date()): SeasonState {
  const { regStart, regEnd, playoffEnd } = pickWindow(sport, today)
  const ms = today.getTime()
  const day = 86_400_000

  if (ms < regStart.getTime()) {
    const days = Math.ceil((regStart.getTime() - ms) / day)
    return {
      sport,
      label: LABEL[sport],
      phase: 'offseason',
      pctRemaining: null,
      daysRemaining: days,
      next: { phase: 'regular', on: regStart.toISOString().slice(0, 10) },
    }
  }
  if (ms <= regEnd.getTime()) {
    const total = regEnd.getTime() - regStart.getTime()
    const elapsed = ms - regStart.getTime()
    const pct = Math.max(0, Math.min(1, 1 - elapsed / total))
    return {
      sport,
      label: LABEL[sport],
      phase: 'regular',
      pctRemaining: +(pct * 100).toFixed(1),
      daysRemaining: Math.ceil((regEnd.getTime() - ms) / day),
      next: { phase: 'playoffs', on: regEnd.toISOString().slice(0, 10) },
    }
  }
  if (ms <= playoffEnd.getTime()) {
    return {
      sport,
      label: LABEL[sport],
      phase: 'playoffs',
      pctRemaining: null,
      daysRemaining: Math.ceil((playoffEnd.getTime() - ms) / day),
      next: { phase: 'offseason', on: playoffEnd.toISOString().slice(0, 10) },
    }
  }
  const nextStart = pickWindow(sport, new Date(playoffEnd.getTime() + day)).regStart
  return {
    sport,
    label: LABEL[sport],
    phase: 'offseason',
    pctRemaining: null,
    daysRemaining: Math.ceil((nextStart.getTime() - ms) / day),
    next: { phase: 'regular', on: nextStart.toISOString().slice(0, 10) },
  }
}

const PHASE_ORDER: Record<SeasonPhase, number> = { regular: 0, playoffs: 1, offseason: 2 }

export function rankedSeasons(today = new Date()): SeasonState[] {
  const all: SportKey[] = ['NFL', 'NBA', 'NHL', 'MLB']
  return all
    .map((s) => seasonStateFor(s, today))
    .sort((a, b) => {
      if (a.phase !== b.phase) return PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase]
      if (a.phase === 'regular') return (b.pctRemaining ?? 0) - (a.pctRemaining ?? 0)
      return (a.daysRemaining ?? 0) - (b.daysRemaining ?? 0)
    })
}
