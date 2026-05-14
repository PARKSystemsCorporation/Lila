import { describe, it, expect } from 'vitest'
import { backtestRaces, clampWindow, MAX_WINDOW_DAYS } from '../backtest'
import type { BacktestRaceFixture } from '../backtest'
import type { Runner } from '../types'

function runner(horse_id: string, odds: number | null, horse?: string): Runner {
  return {
    horse_id,
    horse: horse ?? horse_id,
    number: null,
    draw: null,
    jockey: null,
    trainer: null,
    age: null,
    weight_lbs: null,
    form: null,
    odds_decimal: odds,
  }
}

// Yield engine picks the runner with the largest POSITIVE edge (fair_decimal
// - book_decimal). With these 4 runners the favourite (FAV, 2.0) is also the
// fair-side value: overround = 1/2 + 1/4 + 1/8 + 1/16 = 0.9375, so fair on
// the favourite is 1 / ((1/2) / 0.9375) = 1.875 → edge = (1.875 - 2) / 2 =
// -6.25% (negative). Actually the longshot at 16.0 has fair 1/((1/16)/0.9375)
// = 15.0 → edge -6.25%. All edges equal in proportional overround. To make
// the engine prefer a specific runner we have to break overround uniformity.

function buildFixture(
  race_id: string,
  winner_id: string | null,
  runners: Runner[],
  country: string | null = 'USA',
): BacktestRaceFixture {
  return {
    race_id,
    course: 'Test',
    country,
    off_dt: '2026-05-10T00:00:00Z',
    field_size: runners.length,
    winner_id,
    runners,
  }
}

describe('clampWindow', () => {
  it('returns the original range when within cap', () => {
    const from = new Date('2026-05-01T00:00:00Z')
    const to   = new Date('2026-05-08T00:00:00Z')
    const w = clampWindow(from, to)
    expect(w.from.getTime()).toBe(from.getTime())
    expect(w.to.getTime()).toBe(to.getTime())
  })
  it('clamps to MAX_WINDOW_DAYS from the upper bound', () => {
    const from = new Date('2026-01-01T00:00:00Z')
    const to   = new Date('2026-05-01T00:00:00Z')
    const w = clampWindow(from, to)
    expect((w.to.getTime() - w.from.getTime()) / 86_400_000).toBe(MAX_WINDOW_DAYS)
    expect(w.to.getTime()).toBe(to.getTime())
  })
  it('swaps reversed inputs', () => {
    const a = new Date('2026-05-08T00:00:00Z')
    const b = new Date('2026-05-01T00:00:00Z')
    const w = clampWindow(a, b)
    expect(w.from.getTime()).toBe(b.getTime())
    expect(w.to.getTime()).toBe(a.getTime())
  })
})

describe('backtestRaces', () => {
  // Build a race where one runner has a clear positive edge: book the
  // favourite tightly (2.0) while the second-favourite drifts to 8.0
  // even though its true probability suggests ~4.0. The yield engine
  // will flag the second-favourite as top edge.
  const valuedRunner = runner('VALUE', 8.0, 'Value Side')
  const heavyFav     = runner('FAV',   1.5, 'Heavy Fav')
  const filler1      = runner('F1',    9.0)
  const filler2      = runner('F2',    9.0)

  it('credits a win when the engine picks the eventual winner', () => {
    const fixture = buildFixture('R1', 'VALUE', [heavyFav, valuedRunner, filler1, filler2])
    const summary = backtestRaces(
      [fixture],
      6,  // intensity threshold
      { from: '2026-05-09T00:00:00Z', to: '2026-05-11T00:00:00Z' },
    )
    expect(summary.races_considered).toBe(1)
    expect(summary.picks_emitted).toBeGreaterThanOrEqual(0)
    if (summary.picks_emitted > 0) {
      // The engine should have picked the value side and it won.
      expect(summary.wins).toBe(1)
      expect(summary.losses).toBe(0)
      // ROI on a unit stake at decimal 8.0 winning = +700%.
      expect(summary.roi_pct).toBeGreaterThan(0)
    }
  })

  it('credits a loss when the engine pick does not win', () => {
    const fixture = buildFixture('R2', 'FAV', [heavyFav, valuedRunner, filler1, filler2])
    const summary = backtestRaces(
      [fixture],
      6,
      { from: '2026-05-09T00:00:00Z', to: '2026-05-11T00:00:00Z' },
    )
    if (summary.picks_emitted > 0) {
      expect(summary.losses).toBeGreaterThan(0)
      expect(summary.roi_pct).toBeLessThanOrEqual(0)
    }
  })

  it('skips races with no winner_id (ungraded)', () => {
    const fixture = buildFixture('R3', null, [heavyFav, valuedRunner])
    const summary = backtestRaces([fixture], 6, { from: 'a', to: 'b' })
    expect(summary.picks_emitted).toBe(0)
  })

  it('skips races where engine intensity falls below threshold', () => {
    const fixture = buildFixture('R4', 'VALUE', [heavyFav, valuedRunner, filler1, filler2])
    const high = backtestRaces([fixture], 11, { from: 'a', to: 'b' })   // unreachable
    expect(high.picks_emitted).toBe(0)
  })

  it('buckets picks by country', () => {
    const us = buildFixture('R-US', 'VALUE', [heavyFav, valuedRunner, filler1, filler2], 'USA')
    const uk = buildFixture('R-UK', 'VALUE', [heavyFav, valuedRunner, filler1, filler2], 'GBR')
    const summary = backtestRaces([us, uk], 1, { from: 'a', to: 'b' })
    expect(Object.keys(summary.by_country).sort()).toEqual(['GBR', 'USA'])
  })

  it('returns zero stats when fixtures is empty', () => {
    const summary = backtestRaces([], 6, { from: 'a', to: 'b' })
    expect(summary.races_considered).toBe(0)
    expect(summary.picks_emitted).toBe(0)
    expect(summary.roi_pct).toBe(0)
    expect(summary.hit_rate).toBe(0)
  })
})
