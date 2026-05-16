import { describe, it, expect } from 'vitest'
import { timingSafeEqualHex } from '../ct-compare'

describe('timingSafeEqualHex', () => {
  const hash = 'a'.repeat(64)

  it('returns true for identical strings', () => {
    expect(timingSafeEqualHex(hash, hash)).toBe(true)
  })

  it('returns false when a single char differs', () => {
    expect(timingSafeEqualHex(hash, 'b' + hash.slice(1))).toBe(false)
    expect(timingSafeEqualHex(hash, hash.slice(0, 63) + 'b')).toBe(false)
  })

  it('returns false on length mismatch without throwing', () => {
    expect(timingSafeEqualHex(hash, hash.slice(0, 32))).toBe(false)
    expect(timingSafeEqualHex('', hash)).toBe(false)
    expect(timingSafeEqualHex(hash, '')).toBe(false)
  })

  it('returns true for two empty strings', () => {
    expect(timingSafeEqualHex('', '')).toBe(true)
  })
})
