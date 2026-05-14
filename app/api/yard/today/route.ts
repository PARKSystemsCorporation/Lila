import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({
      picks: [],
      generated_at: new Date().toISOString(),
      status: { creds_ok: false, count: 0 },
    })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const { rows: picks } = await db.query(
      `SELECT id, symbol, direction, entry_price, target_price, stop_loss,
              confidence, risk_level, reason, status, created_at
         FROM analyst_picks
        WHERE asset_class = 'etf/macro'
          AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')
        ORDER BY confidence DESC, created_at DESC`
    )
    return NextResponse.json({
      picks,
      generated_at: new Date().toISOString(),
      status: { creds_ok: true, count: picks.length },
    })
  } finally {
    db.release()
  }
}
