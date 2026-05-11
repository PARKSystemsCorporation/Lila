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

  it('batched processMsg writes one row per unique pair across a long message', async () => {
    // Long noun-heavy line — many unique pairs in a single processMsg call.
    // Before the batch rewrite this would have been ~4 queries per pair; after
    // batching, the row count is the only thing we can assert easily without
    // pulling pg_stat_statements.
    const text =
      'cipher dispatched router task vega analyzed bounty target watchlist ' +
      'submission lesson priority macro thesis pattern alpha beta gamma delta epsilon'
    await processMsg(db, text)
    const { rows } = await db.query(
      `SELECT (SELECT COUNT(*) FROM memory_short) +
              (SELECT COUNT(*) FROM memory_medium) +
              (SELECT COUNT(*) FROM memory_long) AS total`
    )
    // 22 tokens, window=5 → 22*4 - C(5,2) ≈ 78 pair occurrences. Dedupe by
    // pk yields somewhere in 60-78 unique rows (some duplicates within the
    // window are possible if the same word appears twice). Just assert
    // "many rows wrote and nothing crashed".
    expect(Number(rows[0].total)).toBeGreaterThan(40)
  })

  it('batched processMsg preserves same-tier reinforcement (reinf bumps, score climbs)', async () => {
    await processMsg(db, 'orange purple yellow')   // 3 tokens, 3 pairs
    const before = await search(db, 'orange')
    expect(before.length).toBeGreaterThan(0)
    const r0 = before[0]
    await processMsg(db, 'orange purple yellow')   // same message → same pairs reinforced
    const after = await search(db, 'orange')
    const r1 = after.find(c => c.pk === r0.pk)!
    expect(r1).toBeDefined()
    expect(r1.reinf).toBeGreaterThan(r0.reinf)
    expect(r1.score).toBeGreaterThanOrEqual(r0.score)
  })
})
