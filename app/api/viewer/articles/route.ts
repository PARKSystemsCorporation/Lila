import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Read-only viewer articles feed. Returns ONLY published articles
// (status='published') across the three authors. Drafts + dismissed
// stay private. Replaces the operator's Substack copy-paste flow —
// viewers read directly on /viewer.

export async function GET() {
  if (!process.env.DATABASE_URL) return NextResponse.json({ articles: [] })

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const { rows } = await db.query(
      `SELECT id, title, content, author, kind, external_url,
              (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_ts
       FROM articles
       WHERE status = 'published'
       ORDER BY created_at DESC
       LIMIT 100`
    )
    return NextResponse.json({
      articles: rows.map(r => ({
        id: Number(r.id),
        title: r.title,
        content: r.content,
        author: r.author ?? 'lila',
        kind: r.kind ?? 'noon-report',
        external_url: r.external_url,
        created_ts: Number(r.created_ts),
      })),
    })
  } finally { db.release() }
}
