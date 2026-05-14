import { describe, it, expect } from 'vitest'
import { overroundScore } from '../metrics/overround'
import { consensusScore } from '../metrics/consensus'
import { leadFraction, leadPctScore } from '../metrics/lead-pct'
import { steamScore } from '../metrics/steam'
import { deltaScore } from '../metrics/delta'
import { publicGravityScore } from '../metrics/public-gravity'
import { whaleScore } from '../metrics/whale'
import { lockScore } from '../metrics/lock'
import { compositeScore } from '../metrics/composite'

describe('overroundScore', () => {
  it('maps every 10pp of overround to one tier', () => {
    expect(overroundScore({ overround_pct: 5 })).toBe(1)
    expect(overroundScore({ overround_pct: 10 })).toBe(1)
    expect(overroundScore({ overround_pct: 11 })).toBe(2)
    expect(overroundScore({ overround_pct: 50 })).toBe(5)
    expect(overroundScore({ overround_pct: 71 })).toBe(8)
    expect(overroundScore({ overround_pct: 100 })).toBe(10)
    expect(overroundScore({ overround_pct: 250 })).toBe(10)
  })

  it('treats non-positive overround as the floor', () => {
    expect(overroundScore({ overround_pct: 0 })).toBe(1)
    expect(overroundScore({ overround_pct: -8 })).toBe(1)
  })
})

describe('consensusScore', () => {
  it('returns 1 for the underdog regardless of inputs', () => {
    expect(consensusScore({ overround_1to10: 9, is_lead_team: false, data_points: 1 })).toBe(1)
  })

  it('divides by data points and clamps', () => {
    expect(consensusScore({ overround_1to10: 10, is_lead_team: true, data_points: 1 })).toBe(10)
    expect(consensusScore({ overround_1to10: 8, is_lead_team: true, data_points: 2 })).toBe(4)
    expect(consensusScore({ overround_1to10: 5, is_lead_team: true, data_points: 5 })).toBe(1)
  })

  it('floors invalid data point counts', () => {
    expect(consensusScore({ overround_1to10: 7, is_lead_team: true, data_points: 0 })).toBe(1)
  })
})

describe('lead-pct milestone formula', () => {
  it('respects the 0.01..0.99 clamp', () => {
    expect(leadFraction({ e_lead: 0, e_total: 0, during_pull: false })).toBeCloseTo(0.01, 2)
    expect(leadFraction({ e_lead: 1000, e_total: 1000, during_pull: true })).toBeLessThan(1)
  })

  it('gives the pull bonus a measurable lift', () => {
    const without = leadFraction({ e_lead: 5, e_total: 10, during_pull: false })
    const withPull = leadFraction({ e_lead: 5, e_total: 10, during_pull: true })
    expect(withPull).toBeGreaterThan(without)
  })

  it('maps fraction to 1..10 via ceil(*10)', () => {
    expect(leadPctScore({ e_lead: 0, e_total: 0, during_pull: false })).toBe(1)
    expect(leadPctScore({ e_lead: 100, e_total: 100, during_pull: true })).toBe(10)
  })
})

describe('steamScore tier boundaries', () => {
  const w = 30_000 // well inside the 2-minute window
  it.each([
    [0.00, w, 1], [0.01, w, 1], [0.02, w, 4],
    [0.05, w, 6], [0.07, w, 7], [0.10, w, 8],
    [0.15, w, 9], [0.25, w, 10], [0.40, w, 10],
  ])('delta=%s in %sms → %s', (delta, ms, expected) => {
    expect(steamScore({ delta_cents: delta, elapsed_ms: ms })).toBe(expected)
  })

  it('collapses to 1 when the window is too wide', () => {
    expect(steamScore({ delta_cents: 0.40, elapsed_ms: 5 * 60_000 })).toBe(1)
  })
})

describe('deltaScore tier boundaries', () => {
  it.each([
    [0.00, 1], [0.04, 1], [0.05, 4], [0.08, 5],
    [0.11, 6], [0.15, 7], [0.20, 8], [0.25, 9], [0.30, 10],
  ])('gap=%s → tier %s', (gap, expected) => {
    expect(deltaScore({ gap_cents: gap })).toBe(expected)
  })
})

describe('publicGravityScore', () => {
  it('uses the absolute pull magnitude', () => {
    expect(publicGravityScore({ parlay_line: -3.5, api_sports_line: -3.5 })).toBe(1)
    expect(publicGravityScore({ parlay_line: -3.5, api_sports_line: -3.5 + 0.20 })).toBe(8)
    expect(publicGravityScore({ parlay_line: -3.5, api_sports_line: -3.5 - 0.30 })).toBe(10)
  })
})

describe('whaleScore', () => {
  it('returns 1 when money trails tickets', () => {
    expect(whaleScore({ money_pct: 40, ticket_pct: 60 })).toBe(1)
  })

  it('scales each 5pp of (money - ticket) by one tier', () => {
    expect(whaleScore({ money_pct: 55, ticket_pct: 50 })).toBe(2)
    expect(whaleScore({ money_pct: 70, ticket_pct: 50 })).toBe(5)
    expect(whaleScore({ money_pct: 99, ticket_pct: 50 })).toBe(10)
  })
})

describe('lockScore', () => {
  it('flips to 10 only when retail > sharp_fair + vig', () => {
    expect(lockScore({ retail_cents: 110, sharp_fair_cents: 105, vig_cents: 3 })).toBe(10)
    expect(lockScore({ retail_cents: 108, sharp_fair_cents: 105, vig_cents: 3 })).toBe(1)
    expect(lockScore({ retail_cents: 100, sharp_fair_cents: 105, vig_cents: 3 })).toBe(1)
  })
})

describe('compositeScore', () => {
  it('returns 1 when no inputs are provided', () => {
    expect(compositeScore({})).toBe(1)
  })

  it('returns the same score when every input is identical', () => {
    expect(compositeScore({
      overround: 7, consensus: 7, steam: 7, delta: 7,
      public_gravity: 7, whale: 7, lead_pct: 7, sma10: 7, lock: 7,
    })).toBe(7)
  })

  it('ignores null and non-finite signals', () => {
    const withNulls = compositeScore({ overround: 10, consensus: null, steam: 10, delta: 10 })
    const withoutNulls = compositeScore({ overround: 10, steam: 10, delta: 10 })
    expect(withNulls).toBe(withoutNulls)
  })
})
