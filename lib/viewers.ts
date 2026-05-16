// Park Gates wallet helpers. Grant model: every active viewer earns
// MONTHLY_GRANT (50) Park Gates per calendar month. Each grant is keyed by
// a period ref ('period:YYYY-MM') so the three grant sources are mutually
// idempotent — exactly one 50 PG per viewer per month no matter how many
// fire:
//   • Gumroad recurring `sale` webhook   → reason 'renewal_grant'
//   • /api/viewer/login (current month)  → reason 'monthly_grant'
//   • /api/viewer/login (missed months)  → reason 'backfill_grant'
// A SELECT…FOR UPDATE on the viewer row serializes concurrent webhook/login
// races; the uq_park_gates_ledger_period unique index is the backstop.
// Audit trail lives in park_gates_ledger.

import type { PoolClient } from 'pg'

export const MONTHLY_GRANT = 50

// How many missed prior months a single login will back-pay. Bounds the
// blast radius of a long-dormant subscriber returning.
const BACKFILL_CAP = 12

export interface ViewerWallet {
  id: number
  parkGates: number
  lastGrantAt: Date | null
}

type GrantReason = 'monthly_grant' | 'renewal_grant' | 'backfill_grant'

export function monthRef(d: Date): string {
  return `period:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

// Idempotently credit MONTHLY_GRANT for one billing period (`ref`, e.g.
// 'period:2026-05'). Returns true iff it actually credited; false if the
// period was already granted (any source) or the viewer is inactive.
export async function grantPeriod(
  db: PoolClient,
  viewerId: number,
  ref: string,
  reason: GrantReason,
): Promise<boolean> {
  const cur = await db.query(
    `SELECT active FROM viewers WHERE id = $1 FOR UPDATE`,
    [viewerId],
  )
  if (cur.rowCount === 0) throw new Error(`viewer ${viewerId} not found`)
  if (cur.rows[0].active !== true) return false

  const dup = await db.query(
    `SELECT 1 FROM park_gates_ledger WHERE viewer_id = $1 AND ref = $2 LIMIT 1`,
    [viewerId, ref],
  )
  if ((dup.rowCount ?? 0) > 0) return false

  await db.query(
    `UPDATE viewers
        SET park_gates         = park_gates + $2,
            last_gate_grant_at = NOW()
      WHERE id = $1`,
    [viewerId, MONTHLY_GRANT],
  )
  await db.query(
    `INSERT INTO park_gates_ledger (viewer_id, delta, reason, ref)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [viewerId, MONTHLY_GRANT, reason, ref],
  )
  return true
}

// Grants the current calendar month's 50 PG if not already granted from
// any source. Returns the post-grant wallet snapshot. Idempotent.
export async function grantMonthlyIfDue(
  db: PoolClient,
  viewerId: number,
): Promise<ViewerWallet> {
  await grantPeriod(db, viewerId, monthRef(new Date()), 'monthly_grant')
  const r = await db.query(
    `SELECT id, park_gates, last_gate_grant_at FROM viewers WHERE id = $1`,
    [viewerId],
  )
  if (r.rowCount === 0) throw new Error(`viewer ${viewerId} not found`)
  const row = r.rows[0]
  return {
    id: Number(row.id),
    parkGates: Number(row.park_gates ?? 0),
    lastGrantAt: row.last_gate_grant_at ? new Date(row.last_gate_grant_at) : null,
  }
}

// Back-pay every missed calendar month strictly before the current one
// (the current month is grantMonthlyIfDue's job). Idempotent and capped at
// BACKFILL_CAP credits per call. Returns the number of months credited.
export async function backfillMissedGrants(
  db: PoolClient,
  viewerId: number,
): Promise<number> {
  const cur = await db.query(
    `SELECT created_at, last_gate_grant_at, active FROM viewers WHERE id = $1`,
    [viewerId],
  )
  if (cur.rowCount === 0) return 0
  const row = cur.rows[0]
  if (row.active !== true) return 0

  const now = new Date()
  const curY = now.getUTCFullYear()
  const curM = now.getUTCMonth()

  const anchor: Date = row.last_gate_grant_at
    ? new Date(row.last_gate_grant_at)
    : new Date(row.created_at)
  let y = anchor.getUTCFullYear()
  let m = anchor.getUTCMonth()

  let granted = 0
  while ((y < curY || (y === curY && m < curM)) && granted < BACKFILL_CAP) {
    const ref = `period:${y}-${String(m + 1).padStart(2, '0')}`
    if (await grantPeriod(db, viewerId, ref, 'backfill_grant')) granted++
    m += 1
    if (m > 11) { m = 0; y += 1 }
  }
  return granted
}

export async function getWalletByLicense(
  db: PoolClient,
  licenseKey: string,
): Promise<ViewerWallet | null> {
  const r = await db.query(
    `SELECT id, park_gates, last_gate_grant_at
       FROM viewers
      WHERE license_key = $1`,
    [licenseKey],
  )
  if (r.rowCount === 0) return null
  return {
    id: Number(r.rows[0].id),
    parkGates: Number(r.rows[0].park_gates ?? 0),
    lastGrantAt: r.rows[0].last_gate_grant_at ? new Date(r.rows[0].last_gate_grant_at) : null,
  }
}

export interface SpendResult {
  ok: boolean
  remaining: number
  reason?: 'insufficient' | 'inactive' | 'not_found'
}

// Atomically debit `amount` Park Gates from a viewer's wallet. The
// UPDATE is a single statement so two concurrent spends can't both
// succeed against the same balance. Writes a 'spend' ledger row on
// success.
export async function spendGates(
  db: PoolClient,
  viewerId: number,
  amount: number,
  reason: string,
  ref: string | null,
): Promise<SpendResult> {
  if (amount <= 0) throw new Error('amount must be positive')

  const r = await db.query(
    `UPDATE viewers
        SET park_gates = park_gates - $2
      WHERE id = $1
        AND active = TRUE
        AND park_gates >= $2
      RETURNING park_gates`,
    [viewerId, amount],
  )

  if (r.rowCount === 0) {
    // Distinguish insufficient from inactive/not-found for clean UX.
    const cur = await db.query(
      `SELECT active, park_gates FROM viewers WHERE id = $1`,
      [viewerId],
    )
    if (cur.rowCount === 0) return { ok: false, remaining: 0, reason: 'not_found' }
    if (cur.rows[0].active !== true) return { ok: false, remaining: Number(cur.rows[0].park_gates ?? 0), reason: 'inactive' }
    return { ok: false, remaining: Number(cur.rows[0].park_gates ?? 0), reason: 'insufficient' }
  }

  await db.query(
    `INSERT INTO park_gates_ledger (viewer_id, delta, reason, ref)
     VALUES ($1, $2, $3, $4)`,
    [viewerId, -amount, reason, ref],
  )

  return { ok: true, remaining: Number(r.rows[0].park_gates) }
}
