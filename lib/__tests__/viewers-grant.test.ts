import { describe, it, expect } from 'vitest'
import type { PoolClient } from 'pg'
import { grantPeriod, backfillMissedGrants, monthRef, MONTHLY_GRANT } from '../viewers'

interface Viewer {
  id: number
  active: boolean
  park_gates: number
  last_gate_grant_at: Date | null
  created_at: Date
}
interface Ledger { viewer_id: number; delta: number; reason: string; ref: string | null }

// Stateful fake PoolClient modelling just enough of the viewers +
// park_gates_ledger semantics: the (viewer_id, ref) uniqueness on
// 'period:%' rows and the additive wallet update.
function fakeDb(viewer: Viewer) {
  const ledger: Ledger[] = []
  const query = (async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim()
    if (/SELECT active FROM viewers WHERE id = \$1 FOR UPDATE/.test(s)) {
      return { rows: [{ active: viewer.active }], rowCount: 1 }
    }
    if (/SELECT 1 FROM park_gates_ledger WHERE viewer_id = \$1 AND ref = \$2/.test(s)) {
      const hit = ledger.some(l => l.viewer_id === params[0] && l.ref === params[1])
      return { rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 }
    }
    if (/UPDATE viewers SET park_gates = park_gates \+ \$2/.test(s)) {
      viewer.park_gates += Number(params[1])
      viewer.last_gate_grant_at = new Date()
      return { rows: [], rowCount: 1 }
    }
    if (/INSERT INTO park_gates_ledger/.test(s)) {
      const [viewer_id, delta, reason, ref] = params as [number, number, string, string | null]
      // Emulate the uq_park_gates_ledger_period partial unique index.
      const dupe = ref != null && ref.startsWith('period:') &&
        ledger.some(l => l.viewer_id === viewer_id && l.ref === ref)
      if (!dupe) ledger.push({ viewer_id, delta, reason, ref })
      return { rows: [], rowCount: dupe ? 0 : 1 }
    }
    if (/SELECT created_at, last_gate_grant_at, active FROM viewers/.test(s)) {
      return { rows: [{ created_at: viewer.created_at, last_gate_grant_at: viewer.last_gate_grant_at, active: viewer.active }], rowCount: 1 }
    }
    if (/SELECT id, park_gates, last_gate_grant_at FROM viewers/.test(s)) {
      return { rows: [{ id: viewer.id, park_gates: viewer.park_gates, last_gate_grant_at: viewer.last_gate_grant_at }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }) as unknown as PoolClient['query']
  return { db: { query } as unknown as PoolClient, ledger, viewer }
}

describe('Park Gates grant idempotency + backfill', () => {
  it('grantPeriod credits once and is a no-op on repeat (webhook retry safe)', async () => {
    const { db, ledger, viewer } = fakeDb({
      id: 1, active: true, park_gates: 0, last_gate_grant_at: null, created_at: new Date(),
    })
    const ref = monthRef(new Date())
    expect(await grantPeriod(db, 1, ref, 'renewal_grant')).toBe(true)
    expect(await grantPeriod(db, 1, ref, 'renewal_grant')).toBe(false)
    expect(await grantPeriod(db, 1, ref, 'monthly_grant')).toBe(false) // other source, same period
    expect(viewer.park_gates).toBe(MONTHLY_GRANT)
    expect(ledger.filter(l => l.ref === ref).length).toBe(1)
  })

  it('grantPeriod refuses an inactive viewer', async () => {
    const { db, viewer } = fakeDb({
      id: 2, active: false, park_gates: 0, last_gate_grant_at: null, created_at: new Date(),
    })
    expect(await grantPeriod(db, 2, monthRef(new Date()), 'renewal_grant')).toBe(false)
    expect(viewer.park_gates).toBe(0)
  })

  it('backfillMissedGrants pays each missed prior month, capped, idempotently', async () => {
    const now = new Date()
    const fourMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 4, 10))
    const { db, ledger, viewer } = fakeDb({
      id: 3, active: true, park_gates: 0, last_gate_grant_at: fourMonthsAgo, created_at: fourMonthsAgo,
    })
    // Mirror reality: the anchor (last-grant) month already has its ledger
    // row, so backfill must not re-pay it — only the 3 months between it
    // and the current month.
    ledger.push({ viewer_id: 3, delta: MONTHLY_GRANT, reason: 'monthly_grant', ref: monthRef(fourMonthsAgo) })
    const first = await backfillMissedGrants(db, 3)
    expect(first).toBe(3)
    expect(viewer.park_gates).toBe(3 * MONTHLY_GRANT)
    // Second call grants nothing — already reconciled.
    expect(await backfillMissedGrants(db, 3)).toBe(0)
    expect(viewer.park_gates).toBe(3 * MONTHLY_GRANT)
  })
})
