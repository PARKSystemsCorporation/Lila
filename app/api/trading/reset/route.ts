import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import * as Alpaca from '@/lib/platforms/alpaca'

export const dynamic = 'force-dynamic'

// POST /api/trading/reset
//
// Wipe trading state so the paper bankroll math starts clean at $100:
//   - Closed-position rows in lila_positions (kills realized P&L history).
//   - Pending / executed analyst_picks (they referenced the old bankroll).
//   - Optionally closes any actually-open Alpaca paper positions so the
//     real account also flattens. (Skip with ?keep_alpaca=1.)
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

    // 1. Close any actual paper positions on Alpaca side first (best effort).
    if (!keepAlpaca && (process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID)) {
      const positions = await Alpaca.getPositions().catch(() => [] as Alpaca.AlpacaPosition[])
      for (const p of positions) {
        const ok = await Alpaca.closePosition(p.symbol).catch(() => false)
        if (ok) alpacaClosed++
        else    alpacaFailed++
      }
    }

    // 2. Drop closed positions (the source of the cumulative P&L number).
    const { rowCount: closedDropped } = await db.query(
      `DELETE FROM lila_positions WHERE status='closed'`
    )
    // 3. Drop open positions too — Alpaca side is flat now (or operator
    //    chose keep_alpaca and is handling it manually). Either way,
    //    the local mirror should be empty so the bankroll math is honest.
    const { rowCount: openDropped } = await db.query(
      `DELETE FROM lila_positions WHERE status='open'`
    )
    // 4. Cancel pending / executed picks that referenced the old bankroll.
    const { rowCount: picksCancelled } = await db.query(
      `UPDATE analyst_picks SET status='dismissed'
       WHERE status IN ('pending','executed')`
    )
    // 5. Reset bounty earnings? NO — those are real money, not paper.
    //    total_earned in lila_state is left untouched.

    return NextResponse.json({
      ok: true,
      alpaca_closed: alpacaClosed,
      alpaca_failed: alpacaFailed,
      positions_dropped: { closed: closedDropped ?? 0, open: openDropped ?? 0 },
      picks_cancelled: picksCancelled ?? 0,
    })
  } finally {
    db.release()
  }
}
