import { describe, it, expect } from 'vitest'
import { buildTeamId } from '../teams'

describe('buildTeamId', () => {
  it('uses first 3 letters of city + first 3 of name + 4 digits', () => {
    const id = buildTeamId('Boston', 'Celtics')
    expect(id).toMatch(/^boscel\d{4}$/)
  })

  it('lowercases and strips non-alpha characters', () => {
    const id = buildTeamId('Los Angeles', 'Trail Blazers')
    // 'los' from "los"; 'tra' from "tra" (the space is stripped before slicing)
    expect(id).toMatch(/^lostra\d{4}$/)
  })

  it('pads short names so the prefix is always 6 letters', () => {
    const id = buildTeamId('LA', '76ers')
    // 'la' padded to 'lax'; numeric prefix stripped → 'ers' (1st 3 alpha)
    expect(id).toMatch(/^laxers\d{4}$/)
  })

  it('changes the random suffix between calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => buildTeamId('Boston', 'Celtics')))
    // Probability of all 20 colliding is ~10^-72; effectively zero.
    expect(ids.size).toBeGreaterThan(1)
  })
})
