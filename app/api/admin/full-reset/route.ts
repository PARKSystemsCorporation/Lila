import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import * as Alpaca from '@/lib/platforms/alpaca'

export const dynamic = 'force-dynamic'

// POST /api/admin/full-reset
//
// Nuclear "clean slate" — wipes paper trading state, the operator desk
// (current + all past papers), and zeroes bounty earnings.
//
//   - Closes any actually-open Alpaca paper positions (best effort).
//     Skip with ?keep_alpaca=1.
//   - DELETE FROM lila_positions               (open + closed history)
//   - UPDATE analyst_picks SET status='dismissed' WHERE pending|executed
//   - DELETE FROM desk_items                   (pending + approved + denied + reported)
//   - UPDATE lila_state SET total_earned=0     (bounty earnings)
//
// security_reports rows are preserved (audit trail). The reconcile flags
// in lila_state stay TRUE so lib/db.ts:47-62 won't repopulate total_earned
// from the security_reports paid sum.
//
// Auth: behind the normal middleware password gate.

export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'no db' }, { status: 503 })
  }

  const url = new URL(req.url)
  const keepAlpaca = url.searchParams.get('keep_alpaca') === '1'

  const pool = getPool()
  const db = await pool.connect()
  let alpacaClosed = 0
  let alpacaFailed = 0

  try {
    await ensureSchema(db)

    // 1. Best-effort flatten Alpaca paper account.
    if (!keepAlpaca && (process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID)) {
      const positions = await Alpaca.getPositions().catch(() => [] as Alpaca.AlpacaPosition[])
      for (const p of positions) {
        const ok = await Alpaca.closePosition(p.symbol).catch(() => false)
        if (ok) alpacaClosed++
        else    alpacaFailed++
      }
    }

    // Snapshot total_earned before zeroing it (for the response).
    const { rows: [pre] } = await db.query(
      `SELECT total_earned FROM lila_state WHERE id=1`
    )
    const totalEarnedBefore = parseFloat(pre?.total_earned ?? '0')

    // 2. Paper trading — wipe local mirror entirely.
    const { rowCount: closedDropped } = await db.query(
      `DELETE FROM lila_positions WHERE status='closed'`
    )
    const { rowCount: openDropped } = await db.query(
      `DELETE FROM lila_positions WHERE status='open'`
    )
    const { rowCount: picksCancelled } = await db.query(
      `UPDATE analyst_picks SET status='dismissed'
       WHERE status IN ('pending','executed')`
    )

    // 3. Desk — pending + approved + denied + reported, the lot.
    const { rowCount: deskDropped } = await db.query(
      `DELETE FROM desk_items`
    )

    // 4. Bounty earnings — zero it. Keep the v2 reconcile flag TRUE so
    //    the migration in lib/db.ts won't recompute from security_reports.
    await db.query(
      `UPDATE lila_state
         SET total_earned             = 0,
             reconciled_paper_pnl     = TRUE,
             reconciled_paper_pnl_v2  = TRUE,
             updated_at               = NOW()
       WHERE id = 1`
    )

    return NextResponse.json({
      ok: true,
      alpaca_closed: alpacaClosed,
      alpaca_failed: alpacaFailed,
      positions_dropped: { closed: closedDropped ?? 0, open: openDropped ?? 0 },
      picks_cancelled: picksCancelled ?? 0,
      desk_dropped: deskDropped ?? 0,
      total_earned_before: totalEarnedBefore,
    })
  } finally {
    db.release()
  }
}
