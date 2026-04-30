// Park Gates wallet helpers. The grant model: every active viewer gets
// 50 PG per calendar month, granted lazily on /api/viewer/login. We don't
// background-tick this — visit-gated grants keep things simple and avoid
// drift if a sub goes inactive between cycles. Audit trail lives in
// park_gates_ledger.

import type { PoolClient } from 'pg'

export const MONTHLY_GRANT = 50

export interface ViewerWallet {
  id: number
  parkGates: number
  lastGrantAt: Date | null
}

// Returns true iff `last` is null or strictly before the start of the
// current UTC calendar month.
function needsMonthlyGrant(last: Date | null): boolean {
  if (!last) return true
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  return last.getTime() < monthStart.getTime()
}

// Grants the monthly 50 PG to a viewer if they're active and either have
// never been granted or were last granted before the current calendar
// month. Returns the post-grant wallet snapshot. Idempotent within a month.
export async function grantMonthlyIfDue(
  db: PoolClient,
  viewerId: number,
): Promise<ViewerWallet> {
  const cur = await db.query(
    `SELECT id, park_gates, last_gate_grant_at, active
       FROM viewers
      WHERE id = $1
      FOR UPDATE`,
    [viewerId],
  )
  if (cur.rowCount === 0) throw new Error(`viewer ${viewerId} not found`)

  const row = cur.rows[0]
  const last: Date | null = row.last_gate_grant_at ? new Date(row.last_gate_grant_at) : null
  const active: boolean = row.active === true

  if (!active || !needsMonthlyGrant(last)) {
    return {
      id: Number(row.id),
      parkGates: Number(row.park_gates ?? 0),
      lastGrantAt: last,
    }
  }

  const upd = await db.query(
    `UPDATE viewers
        SET park_gates         = park_gates + $2,
            last_gate_grant_at = NOW()
      WHERE id = $1
      RETURNING park_gates, last_gate_grant_at`,
    [viewerId, MONTHLY_GRANT],
  )

  await db.query(
    `INSERT INTO park_gates_ledger (viewer_id, delta, reason, ref)
     VALUES ($1, $2, 'monthly_grant', NULL)`,
    [viewerId, MONTHLY_GRANT],
  )

  return {
    id: viewerId,
    parkGates: Number(upd.rows[0].park_gates),
    lastGrantAt: new Date(upd.rows[0].last_gate_grant_at),
  }
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
