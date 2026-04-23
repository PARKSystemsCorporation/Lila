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
              content, confidence, status,
              to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created_at
       FROM security_reports
       ORDER BY created_at DESC`
    )
    return NextResponse.json(rows)
  } finally { db.release() }
}

// POST /api/reports  { id, action: 'approve' | 'dismiss' | 'submitted' }
export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'no db' }, { status: 503 })

  const body = await req.json().catch(() => ({}))
  const id = Number(body.id)
  const action = String(body.action ?? '')
  if (!id || !['approve', 'dismiss', 'submitted'].includes(action)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }
  const statusMap: Record<string, string> = {
    approve: 'approved',
    dismiss: 'dismissed',
    submitted: 'submitted',
  }
  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    await db.query(
      `UPDATE security_reports SET status=$1, updated_at=NOW() WHERE id=$2`,
      [statusMap[action], id]
    )
    return NextResponse.json({ ok: true })
  } finally { db.release() }
}
