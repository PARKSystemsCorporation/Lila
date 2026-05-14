import { describe, it, expect } from 'vitest'
import { clampScore, toColorTier, toLabel, tierTextClass } from '../scale'

describe('clampScore', () => {
  it('rounds, then clamps below 1 and above 10', () => {
    expect(clampScore(0)).toBe(1)
    expect(clampScore(-3)).toBe(1)
    expect(clampScore(11)).toBe(10)
    expect(clampScore(3.4)).toBe(3)
    expect(clampScore(3.6)).toBe(4)
  })

  it('treats non-finite inputs as the floor', () => {
    expect(clampScore(NaN)).toBe(1)
    expect(clampScore(Infinity)).toBe(1)
  })
})

describe('toColorTier', () => {
  it('maps boundaries to the four operator tiers', () => {
    expect(toColorTier(1)).toBe('red')
    expect(toColorTier(2)).toBe('red')
    expect(toColorTier(3)).toBe('yellow')
    expect(toColorTier(5)).toBe('yellow')
    expect(toColorTier(6)).toBe('green')
    expect(toColorTier(7)).toBe('green')
    expect(toColorTier(8)).toBe('purple')
    expect(toColorTier(10)).toBe('purple')
  })
})

describe('toLabel', () => {
  it('returns the operator label for each tier', () => {
    expect(toLabel(1)).toBe('AVOID')
    expect(toLabel(4)).toBe('CAUTIOUS')
    expect(toLabel(7)).toBe('BET IT')
    expect(toLabel(9)).toBe('FULL SEND')
  })
})

describe('tierTextClass', () => {
  it('maps each tier to a tailwind text colour', () => {
    expect(tierTextClass('red')).toBe('text-red-500')
    expect(tierTextClass('yellow')).toBe('text-amber-500')
    expect(tierTextClass('green')).toBe('text-emerald-500')
    expect(tierTextClass('purple')).toBe('text-fuchsia-500')
  })
})
