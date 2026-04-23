import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { Analyst } from '@/lib/analyst'
import * as Alpaca from '@/lib/platforms/alpaca'

export async function GET() {
  const hasAlpaca = !!(process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID)

  let account = null
  let positions: Alpaca.AlpacaPosition[] = []
  if (hasAlpaca) {
    [account, positions] = await Promise.all([
      Alpaca.getAccount().catch(() => null),
      Alpaca.getPositions().catch(() => []),
    ])
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ picks: [], positions: [], account })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const { rows: picks } = await db.query(
      `SELECT * FROM analyst_picks ORDER BY created_at DESC LIMIT 20`
    )
    const { rows: tracked } = await db.query(
      `SELECT * FROM lila_positions ORDER BY opened_at DESC LIMIT 10`
    )
    return NextResponse.json({ picks, positions, tracked, account })
  } finally {
    db.release()
  }
}

// POST — trigger a fresh analysis cycle
export async function POST() {
  if (!process.env.DATABASE_URL || !process.env.DEEPSEEK_API_KEY) {
    return NextResponse.json({ error: 'Missing config' }, { status: 503 })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const analyst = new Analyst()
    const picks = await analyst.analyze()
    await analyst.savePicks(db, picks)
    return NextResponse.json({ picks, count: picks.length })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  } finally {
    db.release()
  }
}
