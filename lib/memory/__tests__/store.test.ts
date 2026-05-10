import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { upsertEntity, findEntityBySlug, writeEpisode, writeSummary, writeMessage } from '../store'
import { hasTestDb, getTestDb, closeTestPool, resetMemory } from './_dbHelper'

const skip = !hasTestDb()
const d = skip ? describe.skip : describe

d('store', () => {
  let db: PoolClient

  beforeAll(async () => { db = await getTestDb() })
  afterAll(async () => { db.release(); await closeTestPool() })
  beforeEach(async () => { await resetMemory(db) })

  it('upsertEntity dedups on (kind, slug) and merges aliases', async () => {
    const id1 = await upsertEntity(db, { kind: 'bounty', slug: 'protocolx', display_name: 'ProtocolX', aliases: ['px'] })
    const id2 = await upsertEntity(db, { kind: 'bounty', slug: 'protocolx', display_name: '', aliases: ['protocolx-v2'] })
    expect(id1).toBe(id2)
    const found = await findEntityBySlug(db, 'protocolx', 'bounty')
    expect(found?.id).toBe(id1)
    expect(found?.display_name).toBe('ProtocolX')  // kept the non-empty value
  })

  it('writeEpisode round-trips with NULL entity_id', async () => {
    const epId = await writeEpisode(db, {
      source: 'chat',
      actor: 'user',
      content: 'lorem ipsum dolor sit amet',
    })
    const { rows } = await db.query('SELECT id, content FROM memory_episodes WHERE id = $1', [epId])
    expect(rows[0].content).toBe('lorem ipsum dolor sit amet')
  })

  it('writeSummary is idempotent on the expression unique index', async () => {
    const ws = new Date('2026-05-09T00:00:00Z')
    const we = new Date('2026-05-10T00:00:00Z')
    const s1 = await writeSummary(db, { level: 'day', window_start: ws, window_end: we, content: 'first take', episode_count: 3 })
    const s2 = await writeSummary(db, { level: 'day', window_start: ws, window_end: we, content: 'refined take', episode_count: 5 })
    expect(s1).toBe(s2)
    const { rows } = await db.query('SELECT content, episode_count FROM memory_summaries WHERE id = $1', [s1])
    expect(rows[0].content).toBe('refined take')
    expect(Number(rows[0].episode_count)).toBe(5)
  })

  it('writeMessage appends to the durable archive', async () => {
    const id = await writeMessage(db, { role: 'user', content: 'hello memory' })
    expect(typeof id).toBe('string')
    const { rows } = await db.query('SELECT role, content FROM memory_messages WHERE id = $1', [id])
    expect(rows[0].role).toBe('user')
    expect(rows[0].content).toBe('hello memory')
  })
})
