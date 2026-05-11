import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Per-kind funnel metrics so the operator (and Lila's autonomy tree)
// can see whether docs are converting. Flags are mechanical thresholds,
// not opinions — the UI decides how loud to be about them.
//
// Thresholds (for docs):
//   attempts >= 3 and 0 paid            → flag 'no-payouts'
//   attempts >= 5 and paidRatio < 0.15  → flag 'low-conversion'

interface KpiRow {
  attempts: number          // every draft we filed (kind count)
  reviewing: number         // awaiting Lila
  approved: number          // Lila said OK, operator hasn't submitted
  submitted: number         // operator sent it in, money pending
  paid: number              // money confirmed
  rejected: number          // Lila killed it
  dismissed: number         // operator killed it
  paid_total: number        // sum of payout values
  max_pending: number       // upper bound on submitted-but-unpaid
  paid_ratio: number        // paid / attempts, 0 if no attempts
  flag: 'ok' | 'no-payouts' | 'low-conversion' | 'new'
}

async function funnelFor(db: import('pg').PoolClient, kind: 'security' | 'docs' | 'code'): Promise<KpiRow> {
  const { rows: [r] } = await db.query(
    `SELECT
       COUNT(*)                                             AS attempts,
       COUNT(*) FILTER (WHERE status='pending_review')      AS reviewing,
       COUNT(*) FILTER (WHERE status='approved')            AS approved,
       COUNT(*) FILTER (WHERE status='submitted')           AS submitted,
       COUNT(*) FILTER (WHERE status='paid')                AS paid,
       COUNT(*) FILTER (WHERE status='rejected')            AS rejected,
       COUNT(*) FILTER (WHERE status='dismissed')           AS dismissed,
       COALESCE(SUM(payout) FILTER (WHERE status='paid'), 0) AS paid_total,
       COALESCE(SUM(reward) FILTER (WHERE status='submitted'), 0) AS max_pending
     FROM security_reports
     WHERE kind=$1`,
    [kind]
  )

  const attempts = Number(r?.attempts ?? 0)
  const paid = Number(r?.paid ?? 0)
  const paidRatio = attempts > 0 ? paid / attempts : 0

  let flag: KpiRow['flag'] = 'ok'
  if (attempts === 0)                        flag = 'new'
  else if (attempts >= 3 && paid === 0)      flag = 'no-payouts'
  else if (attempts >= 5 && paidRatio < 0.15) flag = 'low-conversion'

  return {
    attempts,
    reviewing:   Number(r?.reviewing ?? 0),
    approved:    Number(r?.approved ?? 0),
    submitted:   Number(r?.submitted ?? 0),
    paid,
    rejected:    Number(r?.rejected ?? 0),
    dismissed:   Number(r?.dismissed ?? 0),
    paid_total:  parseFloat(r?.paid_total ?? '0'),
    max_pending: parseFloat(r?.max_pending ?? '0'),
    paid_ratio:  paidRatio,
    flag,
  }
}

export async function GET() {
  const empty: KpiRow = {
    attempts: 0, reviewing: 0, approved: 0, submitted: 0, paid: 0,
    rejected: 0, dismissed: 0, paid_total: 0, max_pending: 0,
    paid_ratio: 0, flag: 'new',
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ docs: empty, security: empty, code: empty })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const [docs, security, code] = await Promise.all([
      funnelFor(db, 'docs'),
      funnelFor(db, 'security'),
      funnelFor(db, 'code'),
    ])
    return NextResponse.json({ docs, security, code })
  } finally { db.release() }
}
