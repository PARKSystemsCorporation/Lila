import { describe, it, expect, vi } from 'vitest'
import { phasedRetry } from '../ceelo-loop'

interface QueryCall { sql: string; params?: unknown[] }

function fakeDb() {
  const calls: QueryCall[] = []
  return {
    calls,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [], rowCount: 0 }
    }) as unknown as import('pg').PoolClient['query'],
  }
}

describe('phasedRetry', () => {
  it('returns success on first attempt and stamps last_phase_at', async () => {
    const db = fakeDb()
    let attempts = 0
    const res = await phasedRetry(db, 'c0', async () => { attempts++; return 42 }, { backoffMs: 0 })
    expect(res).toEqual({ ok: true, value: 42 })
    expect(attempts).toBe(1)
    expect(db.calls.length).toBe(1)
    expect(db.calls[0].sql).toMatch(/last_c0_error = NULL/)
    expect(db.calls[0].sql).toMatch(/last_phase_at/)
  })

  it('retries once after a transient failure, then succeeds', async () => {
    const db = fakeDb()
    let attempts = 0
    const res = await phasedRetry(db, 'c2', async () => {
      attempts++
      if (attempts === 1) throw new Error('transient upstream 5xx')
      return ['hit'] as string[]
    }, { backoffMs: 0 })
    expect(attempts).toBe(2)
    expect(res).toEqual({ ok: true, value: ['hit'] })
    // The successful attempt should have cleared the c2 error column.
    expect(db.calls.at(-1)?.sql).toMatch(/last_c2_error = NULL/)
  })

  it('records the error after two failed attempts', async () => {
    const db = fakeDb()
    let attempts = 0
    const res = await phasedRetry(db, 'c3', async () => {
      attempts++
      throw new Error('persistent failure')
    }, { backoffMs: 0 })
    expect(attempts).toBe(2)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/persistent failure/)
    // Final write should set the column (not clear it).
    const lastWrite = db.calls.at(-1)
    expect(lastWrite?.sql).toMatch(/SET last_c3_error=\$1/)
    expect(lastWrite?.params?.[0]).toMatch(/persistent failure/)
  })

  it('truncates very long error messages', async () => {
    const db = fakeDb()
    const longMsg = 'x'.repeat(500)
    const res = await phasedRetry(db, 'c1', async () => { throw new Error(longMsg) }, { backoffMs: 0 })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      // err() in ceelo-loop truncates at 120 chars.
      expect(res.error.length).toBeLessThanOrEqual(120)
    }
  })
})
