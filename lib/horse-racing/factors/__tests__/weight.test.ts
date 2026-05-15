import { describe, it, expect } from 'vitest'
import { weightScore } from '../weight'
import type { Runner } from '../../types'

function runner(over: Partial<Runner>): Runner {
  return {
    horse_id: 'h', horse: 'h', number: null, draw: null,
    jockey: null, trainer: null, age: null, weight_lbs: null,
    form: null, odds_decimal: null, ...over,
  }
}

describe('weightScore', () => {
  it('returns null when the runner has no weight on the card', () => {
    const field = [runner({ horse_id: 'a', weight_lbs: 120 }), runner({ horse_id: 'b', weight_lbs: 124 })]
    expect(weightScore(runner({ horse_id: 'c', weight_lbs: null }), field)).toBeNull()
  })

  it('rewards lighter weight relative to the field', () => {
    const field = [
      runner({ horse_id: 'a', weight_lbs: 118 }),
      runner({ horse_id: 'b', weight_lbs: 122 }),
      runner({ horse_id: 'c', weight_lbs: 126 }),
    ]
    const light = weightScore(field[0], field)!
    const heavy = weightScore(field[2], field)!
    expect(light).toBeGreaterThan(heavy)
  })

  it('stays within [1,10]', () => {
    const field = [
      runner({ horse_id: 'a', weight_lbs: 110 }),
      runner({ horse_id: 'b', weight_lbs: 120 }),
      runner({ horse_id: 'c', weight_lbs: 130 }),
    ]
    for (const r of field) {
      const v = weightScore(r, field)!
      expect(v).toBeGreaterThanOrEqual(1)
      expect(v).toBeLessThanOrEqual(10)
    }
  })

  it('returns null when stdev is zero (all equal)', () => {
    const field = [
      runner({ horse_id: 'a', weight_lbs: 120 }),
      runner({ horse_id: 'b', weight_lbs: 120 }),
    ]
    expect(weightScore(field[0], field)).toBeNull()
  })
})
