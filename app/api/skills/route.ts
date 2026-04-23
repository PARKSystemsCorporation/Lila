import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json([])
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const { rows } = await db.query(
      `SELECT id, name, description, trigger, code, use_count,
              to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created_at
       FROM lila_skills ORDER BY id DESC`
    )
    return NextResponse.json(rows)
  } finally {
    db.release()
  }
}
