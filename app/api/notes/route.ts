import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Categorize an analyst_notes path into a display bucket.
function categorize(path: string): 'analyst' | 'lila' | 'tasker' | 'pitches' | 'other' {
  if (path.startsWith('lila/pitches/')) return 'pitches'
  if (path.startsWith('lila/'))   return 'lila'
  if (path.startsWith('tasker/')) return 'tasker'
  if (path.startsWith('analyst/')) return 'analyst'
  return 'other'
}

export async function GET(req: Request) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ notes: [], counts: { analyst: 0, lila: 0, tasker: 0, pitches: 0, other: 0, total: 0 } })
  }

  const url = new URL(req.url)
  const id = url.searchParams.get('id')

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    // Single-note fetch for the expanded view (full content).
    if (id) {
      const { rows: [row] } = await db.query(
        `SELECT id, path, content,
                (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_ts,
                (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_ts
         FROM analyst_notes WHERE id=$1`,
        [Number(id)]
      )
      if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
      return NextResponse.json({
        id: Number(row.id),
        path: row.path,
        category: categorize(row.path),
        content: row.content,
        created_ts: Number(row.created_ts),
        updated_ts: Number(row.updated_ts),
      })
    }

    // List: previews only, sorted newest first.
    const { rows } = await db.query(
      `SELECT id, path,
              LEFT(content, 280) AS preview,
              LENGTH(content)    AS size,
              (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_ts,
              (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_ts
       FROM analyst_notes
       ORDER BY updated_at DESC
       LIMIT 500`
    )

    const notes = rows.map(r => ({
      id: Number(r.id),
      path: r.path,
      category: categorize(r.path),
      preview: r.preview,
      size: Number(r.size),
      created_ts: Number(r.created_ts),
      updated_ts: Number(r.updated_ts),
    }))

    const counts = {
      analyst: notes.filter(n => n.category === 'analyst').length,
      lila:    notes.filter(n => n.category === 'lila').length,
      tasker:  notes.filter(n => n.category === 'tasker').length,
      pitches: notes.filter(n => n.category === 'pitches').length,
      other:   notes.filter(n => n.category === 'other').length,
      total:   notes.length,
    }

    return NextResponse.json({ notes, counts })
  } finally { db.release() }
}

// POST /api/notes  { action: 'delete', id: number }
//                  { action: 'delete_category', category: 'analyst'|'lila'|'tasker'|'pitches' }
export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'no db' }, { status: 503 })
  const body = await req.json().catch(() => ({}))
  const action = String(body.action ?? '')

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    if (action === 'delete') {
      const id = Number(body.id)
      if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
      await db.query('DELETE FROM analyst_notes WHERE id=$1', [id])
      return NextResponse.json({ ok: true })
    }

    if (action === 'delete_category') {
      const category = String(body.category ?? '')
      const prefixMap: Record<string, string> = {
        analyst: 'analyst/',
        lila:    'lila/',
        tasker:  'tasker/',
        pitches: 'lila/pitches/',
      }
      const prefix = prefixMap[category]
      if (!prefix) return NextResponse.json({ error: 'bad category' }, { status: 400 })
      // Note: 'lila' deletes the whole lila/ prefix which also includes
      // lila/pitches/. 'pitches' is the narrow cousin of that.
      const { rowCount } = await db.query(
        `DELETE FROM analyst_notes WHERE path LIKE $1`,
        [prefix + '%']
      )
      return NextResponse.json({ ok: true, deleted: rowCount ?? 0 })
    }

    return NextResponse.json({ error: 'bad action' }, { status: 400 })
  } finally { db.release() }
}
