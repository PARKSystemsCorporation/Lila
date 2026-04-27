import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'


export async function GET(req: Request) {
  if (!process.env.DATABASE_URL) return NextResponse.json({ messages: [] })

  const after = parseInt(new URL(req.url).searchParams.get('after') ?? '0')

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const { rows } = await db.query(
      `SELECT id, sender, content,
              (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS timestamp
       FROM chat_messages
       WHERE sender IN ('analyst', 'lila', 'tasker')
         AND thread = 'main'
         AND kind   = 'message'
         AND id > $1
       ORDER BY id ASC LIMIT 30`,
      [after]
    )
    return NextResponse.json({
      messages: rows.map(r => ({
        id: Number(r.id),
        sender: r.sender as string,
        content: r.content as string,
        timestamp: Number(r.timestamp),
      })),
    })
  } finally {
    db.release()
  }
}
