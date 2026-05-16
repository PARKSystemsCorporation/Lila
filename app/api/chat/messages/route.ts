import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'


export async function GET(req: Request) {
  if (!process.env.DATABASE_URL) return NextResponse.json({ messages: [] })

  const after = parseInt(new URL(req.url).searchParams.get('after') ?? '0')
  // No real cursor (initial load / unread probe) → newest window, not the
  // oldest rows. Without this the client crawls 30 rows/poll from id 0 and
  // stays pinned to ancient history forever ("frozen on old data").
  const incremental = Number.isFinite(after) && after > 0

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const { rows } = await db.query(
      incremental
        ? `SELECT id, sender, content,
                  (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS timestamp
           FROM chat_messages
           WHERE sender IN ('analyst', 'lila', 'tasker')
             AND thread = 'main'
             AND kind   = 'message'
             AND id > $1
           ORDER BY id ASC LIMIT 30`
        : `SELECT * FROM (
             SELECT id, sender, content,
                    (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS timestamp
             FROM chat_messages
             WHERE sender IN ('analyst', 'lila', 'tasker')
               AND thread = 'main'
               AND kind   = 'message'
             ORDER BY id DESC LIMIT 30
           ) s ORDER BY id ASC`,
      incremental ? [after] : []
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
