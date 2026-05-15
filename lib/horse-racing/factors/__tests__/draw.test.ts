import { describe, it, expect } from 'vitest'
import { drawScore } from '../draw'
import type { Race, Runner } from '../../types'

function runner(draw: number | null): Runner {
  return {
    horse_id: 'h', horse: 'h', number: null, draw,
    jockey: null, trainer: null, age: null, weight_lbs: null,
    form: null, odds_decimal: null,
  }
}

function race(fieldSize: number): Race {
  return {
    race_id: 'r1', course: 'Test', off_time: '14:30',
    off_dt: '2026-05-15T18:30:00Z', race_name: 'r',
    distance: '6f', going: 'fast', type: null,
    field_size: fieldSize, runners: [],
  }
}

describe('drawScore', () => {
  it('returns null when draw is missing', () => {
    expect(drawScore(runner(null), race(10))).toBeNull()
  })

  it('rewards low draws in small fields', () => {
    const small = race(8)
    expect(drawScore(runner(1), small)!).toBeGreaterThan(drawScore(runner(7), small)!)
  })

  it('rewards low draws even more in large fields', () => {
    const big = race(14)
    expect(drawScore(runner(1), big)!).toBe(8)
    expect(drawScore(runner(6), big)!).toBe(6)
    expect(drawScore(runner(12), big)!).toBe(4)
  })

  it('stays within [1,10]', () => {
    for (const d of [1, 4, 7, 10, 15]) {
      const v = drawScore(runner(d), race(12))!
      expect(v).toBeGreaterThanOrEqual(1)
      expect(v).toBeLessThanOrEqual(10)
    }
  })
})
