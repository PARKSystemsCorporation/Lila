import { describe, it, expect } from 'vitest'
import { scoreAllRunners } from '../yield'
import type { Race, Runner } from '../types'

function runner(over: Partial<Runner>): Runner {
  return {
    horse_id: 'h',
    horse: 'Horse',
    number: null,
    draw: null,
    jockey: null,
    trainer: null,
    age: null,
    weight_lbs: null,
    form: null,
    odds_decimal: null,
    ...over,
  }
}

function race(runners: Runner[]): Race {
  return {
    race_id: 'r1',
    course: 'Aqueduct',
    off_time: '14:30',
    off_dt: '2026-05-15T18:30:00Z',
    race_name: 'Test Race',
    distance: '6f',
    going: 'fast',
    type: 'MSW',
    field_size: runners.length,
    runners,
  }
}

describe('scoreAllRunners', () => {
  it('sorts priced runners by composite_score desc', () => {
    const r = race([
      runner({ horse_id: 'a', horse: 'Alpha', odds_decimal: 5.0 }),
      runner({ horse_id: 'b', horse: 'Bravo', odds_decimal: 3.0 }),
      runner({ horse_id: 'c', horse: 'Charlie', odds_decimal: 2.0 }),
    ])
    const scores = scoreAllRunners(r)
    expect(scores).toHaveLength(3)
    expect(scores[0].composite_score).toBeGreaterThanOrEqual(scores[1].composite_score)
    expect(scores[1].composite_score).toBeGreaterThanOrEqual(scores[2].composite_score)
  })

  it('emits null edge components and composite=1 for unpriced runners, trailing the priced ones', () => {
    const r = race([
      runner({ horse_id: 'a', horse: 'Alpha',   odds_decimal: 3.0 }),
      runner({ horse_id: 'b', horse: 'Bravo',   odds_decimal: 4.0 }),
      runner({ horse_id: 'c', horse: 'Charlie', odds_decimal: null }),
    ])
    const scores = scoreAllRunners(r)
    expect(scores).toHaveLength(3)
    const charlie = scores[scores.length - 1]
    expect(charlie.horse_id).toBe('c')
    expect(charlie.composite_score).toBe(1)
    expect(charlie.edge_pct).toBeNull()
    expect(charlie.fair_decimal).toBeNull()
    expect(charlie.edge_component).toBeNull()
  })

  it('fair_decimal × fair_prob ≈ 1 for priced runners', () => {
    const r = race([
      runner({ horse_id: 'a', horse: 'Alpha', odds_decimal: 4.0 }),
      runner({ horse_id: 'b', horse: 'Bravo', odds_decimal: 5.0 }),
    ])
    const scores = scoreAllRunners(r)
    for (const s of scores) {
      if (s.fair_decimal != null && s.fair_prob != null) {
        expect(Math.abs(s.fair_decimal * s.fair_prob - 1)).toBeLessThan(0.05)
      }
    }
  })

  it('composite stays in [1,10] across many inputs', () => {
    const r = race([
      runner({ horse_id: 'a', horse: 'Alpha', odds_decimal: 1.5 }),
      runner({ horse_id: 'b', horse: 'Bravo', odds_decimal: 10.0 }),
      runner({ horse_id: 'c', horse: 'Charlie', odds_decimal: 50.0 }),
    ])
    const scores = scoreAllRunners(r)
    for (const s of scores) {
      expect(s.composite_score).toBeGreaterThanOrEqual(1)
      expect(s.composite_score).toBeLessThanOrEqual(10)
    }
  })

  it('honors per-horse extras when blending the composite', () => {
    const r = race([
      runner({ horse_id: 'a', horse: 'Alpha', odds_decimal: 3.0 }),
      runner({ horse_id: 'b', horse: 'Bravo', odds_decimal: 3.0 }),
    ])
    const a = scoreAllRunners(r, [], { a: { form: 10, jockey: 10, trainer: 10 } })
    const b = scoreAllRunners(r, [], { b: { form: 1, jockey: 1, trainer: 1 } })
    const alpha = a.find(s => s.horse_id === 'a')!
    const bravoLow = b.find(s => s.horse_id === 'b')!
    expect(alpha.composite_score).toBeGreaterThan(bravoLow.composite_score)
  })
})
