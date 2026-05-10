import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { processMsg, search, memoryContext, runDecay, tierOf, nextIdx } from '../correlations'
import { hasTestDb, getTestDb, closeTestPool, resetMemory } from './_dbHelper'

const skip = !hasTestDb()
const d = skip ? describe.skip : describe

d('correlations (DB-backed)', () => {
  let db: PoolClient

  beforeAll(async () => { db = await getTestDb() })
  afterAll(async () => { db.release(); await closeTestPool() })
  beforeEach(async () => { await resetMemory(db) })

  it('tierOf matches 2dkira thresholds', () => {
    expect(tierOf(0.66)).toBe('long')
    expect(tierOf(0.65)).toBe('long')
    expect(tierOf(0.5)).toBe('medium')
    expect(tierOf(0.25)).toBe('medium')
    expect(tierOf(0.1)).toBe('short')
  })

  it('nextIdx is monotonic', async () => {
    const a = await nextIdx(db)
    const b = await nextIdx(db)
    expect(b).toBe(a + 1)
  })

  it('processMsg writes pairs to a tier reachable by search', async () => {
    await processMsg(db, 'Cipher dispatched the router task to Vega yesterday')
    const hits = await search(db, 'cipher')
    expect(hits.length).toBeGreaterThan(0)
    const partners = new Set<string>()
    for (const h of hits) {
      partners.add(h.w1)
      partners.add(h.w2)
    }
    expect(partners.has('cipher')).toBe(true)
  })

  it('reinforcement bumps reinf and (eventually) promotes tier', async () => {
    // Single ingest of a 4-word noun-heavy line — pairs land in short.
    await processMsg(db, 'cipher dispatched router task')
    const before = await search(db, 'cipher')
    expect(before[0].reinf).toBe(1)

    // Repeat 10x — score climbs to 1.0 and pair migrates to long_term.
    for (let i = 0; i < 10; i++) await processMsg(db, 'cipher dispatched router task')
    const after = await search(db, 'cipher')
    expect(after[0].reinf).toBeGreaterThanOrEqual(2)
    expect(after.some(h => h.tier === 'long')).toBe(true)
  })

  it('processMsg(text, "system") does not write correlations (gate matches 2dkira)', async () => {
    await processMsg(db, 'cipher dispatched router task', 'system')
    const hits = await search(db, 'cipher')
    expect(hits.length).toBe(0)
  })

  it('memoryContext returns a connected-pairs sentence', async () => {
    await processMsg(db, 'router dispatches the tool through cipher')
    const line = await memoryContext(db, 'router tool')
    expect(line).toMatch(/^Things you remember:/)
    expect(line.toLowerCase()).toContain('router')
  })

  it('runDecay erodes short-tier scores past their lease', async () => {
    await processMsg(db, 'alpha bravo')
    // Force the counter past the new-pair lease (idx + 100).
    for (let i = 0; i < 110; i++) await nextIdx(db)
    const before = (await search(db, 'alpha'))[0]
    await runDecay(db)
    const after = (await search(db, 'alpha'))[0]
    // Either the row decayed (lower score) or evicted entirely.
    if (after) expect(after.score).toBeLessThan(before.score)
  })
})
