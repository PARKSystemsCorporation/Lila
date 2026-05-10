import { describe, it, expect } from 'vitest'
import { tokenize, pairKey, STOPS } from '../tokens'

describe('tokens.tokenize', () => {
  it('drops stop-words and short tokens', () => {
    const out = tokenize('the cat sat on a mat by it')
    const words = out.map(t => t.word)
    // 'the','on','a','by','it' are stops; 'sat' is 3-char, kept; 'cat' kept; 'mat' kept.
    for (const w of words) {
      expect(STOPS.has(w)).toBe(false)
      expect(w.length).toBeGreaterThanOrEqual(3)
    }
    expect(words).toContain('cat')
    expect(words).toContain('mat')
  })

  it('lowercases and strips punctuation', () => {
    const out = tokenize('Hello, World! Router-DISPATCH tools.')
    const words = out.map(t => t.word)
    for (const w of words) expect(w).toBe(w.toLowerCase())
    expect(words.some(w => /[!,.]/.test(w))).toBe(false)
  })

  it('returns empty for blank input', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('   ')).toEqual([])
    expect(tokenize('!@#$%')).toEqual([])
  })

  it('emits a spos family for every token', () => {
    const out = tokenize('cipher dispatched the router task to vega')
    for (const t of out) {
      expect(['noun', 'adj', 'verb', 'adv', 'other']).toContain(t.spos)
    }
  })
})

describe('tokens.pairKey', () => {
  it('is symmetric — sort order does not matter', () => {
    expect(pairKey('alpha', 'beta')).toBe(pairKey('beta', 'alpha'))
  })

  it('joins lexicographically with underscore', () => {
    expect(pairKey('beta', 'alpha')).toBe('alpha_beta')
    expect(pairKey('zeta', 'alpha')).toBe('alpha_zeta')
  })

  it('produces unique keys for distinct pairs', () => {
    const seen = new Set<string>()
    const words = ['apple', 'banana', 'cherry', 'date', 'eggplant']
    for (let i = 0; i < words.length; i++) {
      for (let j = i + 1; j < words.length; j++) {
        seen.add(pairKey(words[i], words[j]))
      }
    }
    expect(seen.size).toBe(10)  // C(5,2) = 10 unique pairs
  })
})
