import { describe, it, expect } from 'vitest'
import { blendImpliedProbs } from '../yield'
import type { Runner } from '../types'
import type { SourceQuotes } from '../sources/types'

function runner(id: string, odds: number): Runner {
  return {
    horse_id: id, horse: id, number: null, draw: null,
    jockey: null, trainer: null, age: null, weight_lbs: null,
    form: null, odds_decimal: odds,
  }
}

describe('blendImpliedProbs', () => {
  it('falls back to retail-only when aux is empty (identical to legacy math)', () => {
    const runners = [runner('a', 2.0), runner('b', 3.0), runner('c', 5.0)]
    const blended = blendImpliedProbs(runners, [])!
    const sum = [...blended.values()].reduce((s, p) => s + p, 0)
    expect(sum).toBeCloseTo(1, 4)
    // Favourite at 2.0 should have the highest fair_prob.
    expect(blended.get('a')!).toBeGreaterThan(blended.get('b')!)
    expect(blended.get('b')!).toBeGreaterThan(blended.get('c')!)
  })

  it('blends sharp source heavily over retail', () => {
    const runners = [runner('a', 4.0), runner('b', 4.0)]
    const sharp: SourceQuotes = {
      source: 'sharp.pinnacle',
      quotes: {
        a: { odds_decimal: 2.0 },   // sharp thinks A is the favourite
        b: { odds_decimal: 6.0 },
      },
    }
    const blended = blendImpliedProbs(runners, [sharp])!
    // Sharp gets ~62% weight (0.50 / (0.50 + 0.30)) so A's prob should pull
    // well above 0.5.
    expect(blended.get('a')!).toBeGreaterThan(0.55)
    const sum = [...blended.values()].reduce((s, p) => s + p, 0)
    expect(sum).toBeCloseTo(1, 4)
  })

  it('renormalises when an aux source omits a horse', () => {
    const runners = [runner('a', 3.0), runner('b', 3.0), runner('c', 6.0)]
    const sharp: SourceQuotes = {
      source: 'sharp.x',
      quotes: {
        a: { odds_decimal: 2.5 },
        // b missing entirely
        c: { odds_decimal: 8.0 },
      },
    }
    const blended = blendImpliedProbs(runners, [sharp])!
    const sum = [...blended.values()].reduce((s, p) => s + p, 0)
    expect(sum).toBeCloseTo(1, 4)
    // b should still have a probability (purely from retail), not be dropped.
    expect(blended.get('b')!).toBeGreaterThan(0)
  })

  it('accepts implied_prob overrides from prediction-market sources', () => {
    const runners = [runner('a', 3.0), runner('b', 3.0)]
    const pred: SourceQuotes = {
      source: 'prediction.prophetx',
      quotes: {
        a: { implied_prob: 0.7, odds_decimal: null },
        b: { implied_prob: 0.3, odds_decimal: null },
      },
    }
    const blended = blendImpliedProbs(runners, [pred])!
    expect(blended.get('a')!).toBeGreaterThan(blended.get('b')!)
  })

  it('returns null on a degenerate book', () => {
    const runners = [runner('a', 1.0), runner('b', 0.5)] as Runner[]
    // Force degenerate inputs (odds <= 1) — but blendImpliedProbs is
    // called from scoreAllRunners after filtering, so this is the worst
    // case at the boundary.
    const blended = blendImpliedProbs(runners.filter(r => r.odds_decimal != null && r.odds_decimal > 1), [])
    expect(blended).toBeNull()
  })
})
