import { describe, it, expect } from 'vitest'
import { formScore } from '../form'

describe('formScore', () => {
  it('returns null for null / empty / unparseable input', () => {
    expect(formScore(null)).toBeNull()
    expect(formScore('')).toBeNull()
    expect(formScore('???-???')).toBeNull()
  })

  it('weights the most recent finish heaviest', () => {
    const a = formScore('1-9-9-9-9')! // freshest win
    const b = formScore('9-9-9-9-1')! // ancient win
    expect(a).toBeGreaterThan(b)
  })

  it('treats P/F/U/R as the floor', () => {
    expect(formScore('P-P-P-P-P')).toBe(1)
    expect(formScore('F-F-F-F-F')).toBe(1)
  })

  it('maps a straight winner to the ceiling', () => {
    expect(formScore('1-1-1-1-1')).toBe(10)
  })

  it('stays within [1,10] across mixed inputs', () => {
    for (const s of ['1-2-3-4-5', '3-2-P-6-1', '0-0-0-0-0', '1', '5-5-5']) {
      const v = formScore(s)!
      expect(v).toBeGreaterThanOrEqual(1)
      expect(v).toBeLessThanOrEqual(10)
    }
  })

  it('tolerates separators and case', () => {
    expect(formScore('1/2/3/4/5')).toEqual(formScore('1-2-3-4-5'))
    expect(formScore('p-f-u-r-1')).toEqual(formScore('P-F-U-R-1'))
  })
})
