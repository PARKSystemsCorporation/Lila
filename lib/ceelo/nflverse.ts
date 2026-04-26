import { normalizeTeam } from './teams'

// nflverse public dataset — the canonical free source for NFL historical
// games with closing spreads/totals. CC-BY licensed, hosted on GitHub raw.
//
//   https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv
//
// One CSV (~1MB) covers every game since 1999 with home/away/score and
// closing line / total when known. Perfect for seeding Elo + giving Ceelo
// a backtest dataset.

const URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv'

export interface NflverseGame {
  game_id: string            // e.g. "2024_01_BAL_KC"
  season: number             // 2024
  game_type: string          // 'REG' | 'WC' | 'DIV' | 'CON' | 'SB'
  week: number               // 1..18 + 19..22 for postseason
  gameday: string            // 'YYYY-MM-DD'
  away_team: string          // canonical 3-letter abbr (post-normalize)
  home_team: string
  away_score: number | null
  home_score: number | null
  spread_line: number | null  // closing home spread (negative ⇒ home favored)
  total_line: number | null
  completed: boolean
}

// Fetch + parse all games. Caller filters by season range.
export async function fetchAllGames(): Promise<NflverseGame[]> {
  const res = await fetch(URL, { headers: { 'user-agent': 'Lila/Ceelo' } })
  if (!res.ok) throw new Error(`nflverse games.csv ${res.status}`)
  const text = await res.text()
  return parseCsv(text)
}

// Just the seasons in range. Caller controls how far back we walk.
export async function fetchSeasons(seasons: number[]): Promise<NflverseGame[]> {
  const all = await fetchAllGames()
  const want = new Set(seasons)
  return all.filter(g => want.has(g.season))
}

// ── CSV parsing ─────────────────────────────────────────────────────────

function parseCsv(text: string): NflverseGame[] {
  const lines = text.split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) return []

  const header = splitCsvLine(lines[0])
  const idx = (name: string) => header.indexOf(name)

  const I = {
    game_id:    idx('game_id'),
    season:     idx('season'),
    game_type:  idx('game_type'),
    week:       idx('week'),
    gameday:    idx('gameday'),
    away_team:  idx('away_team'),
    home_team:  idx('home_team'),
    away_score: idx('away_score'),
    home_score: idx('home_score'),
    spread_line: idx('spread_line'),
    total_line:  idx('total_line'),
  }
  // game_id, season, week, home/away_team are required.
  if ([I.game_id, I.season, I.week, I.home_team, I.away_team].some(i => i < 0)) {
    return []
  }

  const out: NflverseGame[] = []
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i])
    if (cells.length < header.length) continue
    const home = normalizeTeam(cells[I.home_team])
    const away = normalizeTeam(cells[I.away_team])
    if (!home || !away) continue

    const game_id = cells[I.game_id]
    const season  = parseInt(cells[I.season], 10)
    const week    = parseInt(cells[I.week], 10)
    if (!game_id || !Number.isFinite(season) || !Number.isFinite(week)) continue

    const home_score = numOrNull(cells[I.home_score])
    const away_score = numOrNull(cells[I.away_score])
    out.push({
      game_id,
      season,
      game_type: cells[I.game_type] || 'REG',
      week,
      gameday: cells[I.gameday] || '',
      home_team: home,
      away_team: away,
      home_score,
      away_score,
      spread_line: I.spread_line >= 0 ? numOrNull(cells[I.spread_line]) : null,
      total_line:  I.total_line  >= 0 ? numOrNull(cells[I.total_line])  : null,
      completed: home_score != null && away_score != null,
    })
  }
  return out
}

// Minimal CSV split — no embedded commas in nflverse columns we use, but
// be safe with double-quote escapes anyway.
function splitCsvLine(line: string): string[] {
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

function numOrNull(s: string | undefined): number | null {
  if (!s) return null
  const t = s.trim()
  if (!t || t.toUpperCase() === 'NA') return null
  const n = parseFloat(t)
  return Number.isFinite(n) ? n : null
}
