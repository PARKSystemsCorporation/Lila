import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the per-league source fetchers BEFORE importing SportsLoop.
const sharpFetchers = {
  nba: vi.fn(),
  nfl: vi.fn(),
  mlb: vi.fn(),
}
const retailFetchers = {
  nba: vi.fn(),
  nfl: vi.fn(),
  mlb: vi.fn(),
}
const predictionFetchers = {
  nba: vi.fn(),
  nfl: vi.fn(),
  mlb: vi.fn(),
}

vi.mock('../sources/api-sports',     () => ({ fetchNbaSharpSnapshots:      () => sharpFetchers.nba() }))
vi.mock('../sources/api-sports-nfl', () => ({ fetchNflSharpSnapshots:      () => sharpFetchers.nfl() }))
vi.mock('../sources/api-sports-mlb', () => ({ fetchMlbSharpSnapshots:      () => sharpFetchers.mlb() }))
vi.mock('../sources/parlay',         () => ({ fetchNbaRetailSnapshots:     () => retailFetchers.nba() }))
vi.mock('../sources/parlay-nfl',     () => ({ fetchNflRetailSnapshots:     () => retailFetchers.nfl() }))
vi.mock('../sources/parlay-mlb',     () => ({ fetchMlbRetailSnapshots:     () => retailFetchers.mlb() }))
vi.mock('../sources/prophet-x',      () => ({ fetchNbaPredictionSnapshots: () => predictionFetchers.nba() }))
vi.mock('../sources/prophet-x-nfl',  () => ({ fetchNflPredictionSnapshots: () => predictionFetchers.nfl() }))
vi.mock('../sources/prophet-x-mlb',  () => ({ fetchMlbPredictionSnapshots: () => predictionFetchers.mlb() }))

// Lightweight stand-ins for the metric modules so we can focus on
// league fan-out, not score math.
vi.mock('../teams',                 () => ({ getOrCreateTeamId: async () => 'team_x' }))
vi.mock('../scale',                 () => ({ toColorTier: () => 'green' }))
vi.mock('../metrics/overround',     () => ({ overroundScore:    () => 1 }))
vi.mock('../metrics/consensus',     () => ({ consensusScore:    () => 1 }))
vi.mock('../metrics/steam',         () => ({ steamScore:        () => 1 }))
vi.mock('../metrics/delta',         () => ({ deltaScore:        () => 1 }))
vi.mock('../metrics/public-gravity',() => ({ publicGravityScore:() => 1 }))
vi.mock('../metrics/whale',         () => ({ whaleScore:        () => 1 }))
vi.mock('../metrics/lock',          () => ({ lockScore:         () => 1 }))
vi.mock('../metrics/lead-pct',      () => ({ leadPctScore:      () => 1 }))
vi.mock('../metrics/sma10',         () => ({ sma10Score:        async () => 1 }))
vi.mock('../metrics/composite',     () => ({ compositeScore:    () => 5 }))

import { SportsLoop } from '../sports-loop'

function makeFakeDb() {
  const calls: { sql: string; params?: unknown[] }[] = []
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      if (sql.includes('FROM sports_game_view')) {
        return { rows: [{ updated_at: '1970-01-01T00:00:00Z' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }),
    calls,
  }
}

beforeEach(() => {
  process.env.ENABLE_SPORTS_LOOP = 'true'
  for (const m of Object.values(sharpFetchers))      m.mockReset()
  for (const m of Object.values(retailFetchers))     m.mockReset()
  for (const m of Object.values(predictionFetchers)) m.mockReset()
})

afterEach(() => {
  delete process.env.ENABLE_SPORTS_LOOP
})

describe('SportsLoop.run(league)', () => {
  it('routes the league argument to the matching per-league fetchers', async () => {
    sharpFetchers.nfl.mockResolvedValue([])
    retailFetchers.nfl.mockResolvedValue([])
    predictionFetchers.nfl.mockResolvedValue([])

    const db = makeFakeDb()
    const result = await new SportsLoop(db as unknown as never).run('nfl')

    expect(sharpFetchers.nfl).toHaveBeenCalledTimes(1)
    expect(retailFetchers.nfl).toHaveBeenCalledTimes(1)
    expect(predictionFetchers.nfl).toHaveBeenCalledTimes(1)
    expect(sharpFetchers.nba).not.toHaveBeenCalled()
    expect(sharpFetchers.mlb).not.toHaveBeenCalled()
    expect(result?.logMessage).toMatch(/Sports\[nfl\]/)
  })

  it('persists league=mlb when ticking MLB', async () => {
    sharpFetchers.mlb.mockResolvedValue([{
      home_team: { city: 'Boston', name: 'Red Sox' },
      away_team: { city: 'New York', name: 'Yankees' },
      tipoff_at: '2026-05-15T18:00:00Z',
      status: 'scheduled',
      pct_game_left: null,
      sharp_cents: { home: -110, away: -110 },
      prev_sharp_cents: null,
      observed_at: '2026-05-15T18:00:00Z',
      fair_value_cents: { home: -105, away: -105 },
      vig_cents: 5,
    }])
    retailFetchers.mlb.mockResolvedValue([])
    predictionFetchers.mlb.mockResolvedValue([])

    const db = makeFakeDb()
    await new SportsLoop(db as unknown as never).run('mlb')

    const sportsGamesInsert = db.calls.find(c => c.sql.includes('INSERT INTO sports_games'))
    expect(sportsGamesInsert).toBeDefined()
    expect(sportsGamesInsert!.params).toBeDefined()
    // params[1] is `league` per the INSERT column order.
    expect((sportsGamesInsert!.params as unknown[])[1]).toBe('mlb')
  })

  it('one source rejecting does not abort the loop', async () => {
    sharpFetchers.nba.mockRejectedValue(new Error('boom'))
    retailFetchers.nba.mockResolvedValue([])
    predictionFetchers.nba.mockResolvedValue([])
    const db = makeFakeDb()
    const result = await new SportsLoop(db as unknown as never).run('nba')
    expect(result).not.toBeNull()
  })
})
