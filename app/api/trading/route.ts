import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import * as Alpaca from '@/lib/platforms/alpaca'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const hasAlpaca = !!(process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID)

  // Optional period for the equity curve (?period=1M by default).
  const period = new URL(req.url).searchParams.get('period') ?? '1M'
  const timeframe = period === '1D' ? '5Min' : '1D'

  // Live Alpaca data
  const [account, positions, history] = hasAlpaca
    ? await Promise.all([
        Alpaca.getAccount().catch(() => null),
        Alpaca.getPositions().catch(() => [] as Alpaca.AlpacaPosition[]),
        Alpaca.getPortfolioHistory(period, timeframe).catch(() => null),
      ])
    : [null, [] as Alpaca.AlpacaPosition[], null]

  // Trade log from our DB
  let tracked: Array<Record<string, unknown>> = []
  let closedTrades: Array<Record<string, unknown>> = []
  let dailyClosedPnl: Array<{ date: string; pnl: number; trades: number }> = []

  if (process.env.DATABASE_URL) {
    const pool = getPool()
    const db = await pool.connect()
    try {
      await ensureSchema(db)
      const { rows: trackedRows } = await db.query(
        `SELECT id, symbol, direction, entry_price, target_price, stop_loss,
                platform, pick_id, status, pnl,
                opened_at, closed_at
         FROM lila_positions
         WHERE status='open'
         ORDER BY opened_at DESC`
      )
      tracked = trackedRows

      const { rows: closedRows } = await db.query(
        `SELECT id, symbol, direction, entry_price, target_price, stop_loss,
                platform, pick_id, status, pnl, opened_at, closed_at
         FROM lila_positions
         WHERE status='closed'
         ORDER BY closed_at DESC NULLS LAST
         LIMIT 100`
      )
      closedTrades = closedRows

      // Daily closed-trade P&L — drives the "realized cumulative P&L" chart.
      const { rows: dailyRows } = await db.query(
        `SELECT to_char(closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d,
                COALESCE(SUM(pnl), 0) AS pnl,
                COUNT(*) AS n
         FROM lila_positions
         WHERE status='closed' AND closed_at IS NOT NULL
         GROUP BY d
         ORDER BY d ASC`
      )
      dailyClosedPnl = dailyRows.map(r => ({
        date: String(r.d),
        pnl: parseFloat(r.pnl ?? '0'),
        trades: Number(r.n),
      }))
    } finally { db.release() }
  }

  // Enrich open positions with tracked target/stop if we have them.
  const trackedBySymbol: Record<string, Record<string, unknown>> = {}
  for (const t of tracked) {
    const sym = String(t.symbol ?? '').toUpperCase()
    trackedBySymbol[sym] = t
  }
  const openPositions = positions.map(p => {
    const t = trackedBySymbol[p.symbol.toUpperCase()]
    return {
      ...p,
      target_price: t?.target_price ?? null,
      stop_loss: t?.stop_loss ?? null,
      opened_at: t?.opened_at ?? null,
    }
  })

  return NextResponse.json({
    account,
    openPositions,
    closedTrades,
    portfolioHistory: history,
    dailyClosedPnl,
    period,
    timeframe,
    hasAlpaca,
  })
}
