import { describe, it, expect } from 'vitest'
import { spreadSplitFromMove, totalSplitFromMove } from '../derive'

describe('spreadSplitFromMove', () => {
  it('returns null when either snapshot is missing', () => {
    expect(spreadSplitFromMove(null, -7.5)).toBeNull()
    expect(spreadSplitFromMove(-7.5, null)).toBeNull()
    expect(spreadSplitFromMove(null, null)).toBeNull()
  })

  it('returns null when the line has not moved', () => {
    expect(spreadSplitFromMove(-3.5, -3.5)).toBeNull()
  })

  it('flags home as popular when the line drops (more negative)', () => {
    const out = spreadSplitFromMove(-3, -5)
    expect(out).not.toBeNull()
    expect(out!.popular_side).toBe('home')
    expect(out!.bets_pct).toBeGreaterThan(50)
    expect(out!.money_pct).toBeGreaterThan(50)
  })

  it('flags away as popular when the line climbs', () => {
    const out = spreadSplitFromMove(-3, -1)
    expect(out!.popular_side).toBe('away')
  })

  it('caps the magnitude at 3 points', () => {
    const big   = spreadSplitFromMove(-3, -8)   // 5-point move
    const three = spreadSplitFromMove(-3, -6)   // 3-point move
    expect(big!.bets_pct).toBe(three!.bets_pct)
    expect(big!.money_pct).toBe(three!.money_pct)
  })

  it('bets band hits 90 at a 3-point move', () => {
    const out = spreadSplitFromMove(0, -3)
    expect(out!.bets_pct).toBe(90)
    expect(out!.money_pct).toBe(85)
  })
})

describe('totalSplitFromMove', () => {
  it('rising total flags over', () => {
    const out = totalSplitFromMove(225, 227)
    expect(out!.popular_side).toBe('over')
  })

  it('falling total flags under', () => {
    const out = totalSplitFromMove(225, 223)
    expect(out!.popular_side).toBe('under')
  })

  it('returns null on no move', () => {
    expect(totalSplitFromMove(225, 225)).toBeNull()
  })
})
