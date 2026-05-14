import { normalizeTeam } from './teams'

// nflverse play-by-play. Per-season CSV with every play, ~50k rows × 370
// columns × 12-ish years available. Raw rows are NOT persisted — we fetch,
// aggregate to per-team metrics, and discard.
//
//   https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_YYYY.csv
//
// EPA (Expected Points Added) is the gold-standard handicapping metric:
// each play has a value in expected-points before snap and after, and EPA
// is the delta. Summed/averaged per team, it captures how much better the
// offense is than league-average and how much the defense suppresses the
// other team. Net EPA per play correlates ~0.85 with season win pct.

const URL = (season: number) =>
  `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv`

export interface TeamEpaAgg {
  team: string
  season: number
  // Offense (when team has the ball)
  epa_per_play: number
  pass_epa: number
  rush_epa: number
  success_rate: number
  plays_offense: number
  // Defense (when team is on D)
  epa_allowed: number
  pass_epa_allowed: number
  rush_epa_allowed: number
  success_allowed: number
  plays_defense: number
  // Net (offense - defense allowed), the headline number
  net_epa: number
}

interface RunningTotals {
  plays: number
  epa: number
  success: number
  pass_plays: number
  pass_epa: number
  rush_plays: number
  rush_epa: number
}

function emptyTotals(): RunningTotals {
  return { plays: 0, epa: 0, success: 0, pass_plays: 0, pass_epa: 0, rush_plays: 0, rush_epa: 0 }
}

// Pull a season's play-by-play and aggregate to per-team EPA.
// Returns an array of TeamEpaAgg, one row per (team, season).
export async function fetchSeasonAggregates(season: number): Promise<TeamEpaAgg[]> {
  const res = await fetch(URL(season), {
    headers: { 'user-agent': 'Lila/Ceelo' },
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`nflverse pbp ${season}: ${res.status}`)
  const text = await res.text()
  return aggregate(text, season)
}

// Parse the CSV by hand. We only care about a handful of columns; rather
// than parse every cell of every row (~370 cols × 50k rows = 18M cells)
// we resolve column indices once from the header, then for each row find
// just the cells we need by index, walking the line with a small state
// machine that respects quoted commas (nflverse `desc` column has commas).
function aggregate(text: string, season: number): TeamEpaAgg[] {
  const headerEnd = text.indexOf('\n')
  if (headerEnd < 0) return []
  const headerLine = text.slice(0, headerEnd).replace(/\r$/, '')
  const header = parseCsvLine(headerLine)

  const I = {
    posteam:     header.indexOf('posteam'),
    defteam:     header.indexOf('defteam'),
    epa:         header.indexOf('epa'),
    success:     header.indexOf('success'),
    pass:        header.indexOf('pass'),
    rush:        header.indexOf('rush'),
    play_type:   header.indexOf('play_type'),
  }
  if ([I.posteam, I.defteam, I.epa, I.play_type].some(i => i < 0)) {
    throw new Error(`nflverse pbp ${season}: missing expected columns`)
  }

  const offense = new Map<string, RunningTotals>()
  const defense = new Map<string, RunningTotals>()

  // Bail per row after we've collected the cells we need (saves work).
  const maxIdx = Math.max(I.posteam, I.defteam, I.epa, I.success, I.pass, I.rush, I.play_type)

  let cursor = headerEnd + 1
  while (cursor < text.length) {
    let lineEnd = text.indexOf('\n', cursor)
    if (lineEnd < 0) lineEnd = text.length
    const line = text.slice(cursor, lineEnd).replace(/\r$/, '')
    cursor = lineEnd + 1
    if (!line) continue

    const cells = parseCsvLineUpTo(line, maxIdx)
    if (cells.length <= maxIdx) continue

    const playType = cells[I.play_type]
    if (playType !== 'pass' && playType !== 'run') continue

    const epaStr = cells[I.epa]
    if (!epaStr || epaStr === 'NA') continue
    const epa = parseFloat(epaStr)
    if (!Number.isFinite(epa)) continue

    const success = I.success >= 0 ? (cells[I.success] === '1' ? 1 : 0) : 0
    const isPass  = playType === 'pass'
    const isRush  = playType === 'run'

    const pos = normalizeTeam(cells[I.posteam])
    const def = normalizeTeam(cells[I.defteam])
    if (!pos || !def) continue

    // Offense aggregate
    let oa = offense.get(pos)
    if (!oa) { oa = emptyTotals(); offense.set(pos, oa) }
    oa.plays++; oa.epa += epa; oa.success += success
    if (isPass) { oa.pass_plays++; oa.pass_epa += epa }
    if (isRush) { oa.rush_plays++; oa.rush_epa += epa }

    // Defense aggregate (epa is from offense's POV; defense "allows" it)
    let da = defense.get(def)
    if (!da) { da = emptyTotals(); defense.set(def, da) }
    da.plays++; da.epa += epa; da.success += success
    if (isPass) { da.pass_plays++; da.pass_epa += epa }
    if (isRush) { da.rush_plays++; da.rush_epa += epa }
  }

  const teamSet = new Set<string>()
  offense.forEach((_, k) => teamSet.add(k))
  defense.forEach((_, k) => teamSet.add(k))
  const teams: string[] = []
  teamSet.forEach(t => teams.push(t))
  const out: TeamEpaAgg[] = []
  for (const team of teams) {
    const o = offense.get(team) ?? emptyTotals()
    const d = defense.get(team) ?? emptyTotals()
    if (o.plays === 0 && d.plays === 0) continue

    const epa_per_play     = o.plays ? o.epa / o.plays : 0
    const pass_epa         = o.pass_plays ? o.pass_epa / o.pass_plays : 0
    const rush_epa         = o.rush_plays ? o.rush_epa / o.rush_plays : 0
    const success_rate     = o.plays ? o.success / o.plays : 0

    const epa_allowed      = d.plays ? d.epa / d.plays : 0
    const pass_epa_allowed = d.pass_plays ? d.pass_epa / d.pass_plays : 0
    const rush_epa_allowed = d.rush_plays ? d.rush_epa / d.rush_plays : 0
    const success_allowed  = d.plays ? d.success / d.plays : 0

    const net_epa = epa_per_play - epa_allowed

    out.push({
      team, season,
      epa_per_play:     +epa_per_play.toFixed(4),
      pass_epa:         +pass_epa.toFixed(4),
      rush_epa:         +rush_epa.toFixed(4),
      success_rate:     +success_rate.toFixed(4),
      plays_offense:    o.plays,
      epa_allowed:      +epa_allowed.toFixed(4),
      pass_epa_allowed: +pass_epa_allowed.toFixed(4),
      rush_epa_allowed: +rush_epa_allowed.toFixed(4),
      success_allowed:  +success_allowed.toFixed(4),
      plays_defense:    d.plays,
      net_epa:          +net_epa.toFixed(4),
    })
  }
  return out
}

// Full CSV-line split honoring quoted commas + escaped quotes.
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"')                   { inQ = false }
      else                                   { cur += c }
    } else {
      if (c === ',')      { out.push(cur); cur = '' }
      else if (c === '"') { inQ = true }
      else                { cur += c }
    }
  }
  out.push(cur)
  return out
}

// Stop after we've collected (maxIdx + 1) cells — saves work on rows
// where we only care about the first ~10 of 370 columns.
function parseCsvLineUpTo(line: string, maxIdx: number): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"')                   { inQ = false }
      else                                   { cur += c }
    } else {
      if (c === ',')      {
        out.push(cur); cur = ''
        if (out.length > maxIdx) return out
      }
      else if (c === '"') { inQ = true }
      else                { cur += c }
    }
  }
  out.push(cur)
  return out
}
