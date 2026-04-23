import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (!process.env.DATABASE_URL) return NextResponse.json([])

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const { rows } = await db.query(
      `SELECT id, bounty_id, platform, platform_label, title, reward, chain, url,
              content, confidence, status, kind, review_notes,
              payout, submitted_at, paid_at,
              to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created_at
       FROM security_reports
       ORDER BY
         CASE status
           WHEN 'approved' THEN 1
           WHEN 'pending_review' THEN 2
           WHEN 'submitted' THEN 3
           WHEN 'paid' THEN 4
           ELSE 5 END,
         created_at DESC`
    )
    return NextResponse.json(rows)
  } finally { db.release() }
}

// POST /api/reports
//   { id, action: 'approve' | 'dismiss' | 'submit' | 'mark_paid' | 'mark_unpaid', payout?: number }
//
// - approve       → status='approved'
// - dismiss       → status='dismissed'
// - submit        → status='submitted', submitted_at=NOW()
// - mark_paid     → status='paid', payout=<amount>, paid_at=NOW().
//                   Increments lila_state.total_earned by the delta.
// - mark_unpaid   → status='submitted', clears payout + paid_at, decrements
//                   total_earned by any previously paid amount.
export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'no db' }, { status: 503 })

  const body = await req.json().catch(() => ({}))
  const id = Number(body.id)
  const action = String(body.action ?? '')
  const payoutInput = body.payout != null ? Number(body.payout) : null

  if (!id || !['approve', 'dismiss', 'submit', 'mark_paid', 'mark_unpaid', 'submitted'].includes(action)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    if (action === 'approve' || action === 'dismiss') {
      const target = action === 'approve' ? 'approved' : 'dismissed'
      await db.query(
        `UPDATE security_reports SET status=$1, updated_at=NOW() WHERE id=$2`,
        [target, id]
      )
      return NextResponse.json({ ok: true })
    }

    // Legacy 'submitted' action name — treat as 'submit'.
    if (action === 'submit' || action === 'submitted') {
      await db.query(
        `UPDATE security_reports
           SET status='submitted',
               submitted_at=COALESCE(submitted_at, NOW()),
               updated_at=NOW()
         WHERE id=$1`,
        [id]
      )
      return NextResponse.json({ ok: true })
    }

    if (action === 'mark_paid') {
      if (payoutInput == null || !Number.isFinite(payoutInput) || payoutInput < 0) {
        return NextResponse.json({ error: 'payout must be a non-negative number' }, { status: 400 })
      }
      // Compute delta: if previously paid, only credit the difference.
      const { rows: [row] } = await db.query(
        `SELECT COALESCE(payout, 0) AS prev FROM security_reports WHERE id=$1`, [id]
      )
      if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
      const prev = parseFloat(row.prev)
      const delta = payoutInput - prev

      await db.query('BEGIN')
      try {
        await db.query(
          `UPDATE security_reports
             SET status='paid', payout=$1, paid_at=NOW(), updated_at=NOW()
           WHERE id=$2`,
          [payoutInput, id]
        )
        if (delta !== 0) {
          await db.query(
            'UPDATE lila_state SET total_earned = total_earned + $1 WHERE id=1',
            [delta]
          )
        }
        await db.query('COMMIT')
      } catch (e) {
        await db.query('ROLLBACK')
        throw e
      }
      return NextResponse.json({ ok: true, delta })
    }

    if (action === 'mark_unpaid') {
      const { rows: [row] } = await db.query(
        `SELECT COALESCE(payout, 0) AS prev FROM security_reports WHERE id=$1`, [id]
      )
      if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
      const prev = parseFloat(row.prev)

      await db.query('BEGIN')
      try {
        await db.query(
          `UPDATE security_reports
             SET status='submitted', payout=NULL, paid_at=NULL, updated_at=NOW()
           WHERE id=$1`,
          [id]
        )
        if (prev !== 0) {
          await db.query(
            'UPDATE lila_state SET total_earned = total_earned - $1 WHERE id=1',
            [prev]
          )
        }
        await db.query('COMMIT')
      } catch (e) {
        await db.query('ROLLBACK')
        throw e
      }
      return NextResponse.json({ ok: true, reverted: prev })
    }

    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  } finally { db.release() }
}
