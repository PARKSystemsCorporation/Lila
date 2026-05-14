import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'

// POST /api/desk/<id>  { action: 'approve' | 'deny' | 'reset', comment? }
//   approve → status='approved' + approved_at=NOW. Lila reads on next tick.
//   deny    → status='denied'   + denied_at=NOW + operator_comment.
//   reset   → return to 'pending' (operator hit the wrong button).
//   delete  → drop the row.

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'no db' }, { status: 503 })
  const { id: idParam } = await params
  const id = Number(idParam)
  if (!id) return NextResponse.json({ error: 'bad id' }, { status: 400 })

  const body = await req.json().catch(() => ({}))
  const action = String(body.action ?? '').toLowerCase()
  const comment = body.comment ? String(body.comment).slice(0, 2000) : null

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    if (action === 'approve') {
      await db.query(
        `UPDATE desk_items
           SET status='approved', approved_at=NOW(), operator_comment=COALESCE($1, operator_comment), updated_at=NOW()
         WHERE id=$2 AND status IN ('pending','denied')`,
        [comment, id]
      )
    } else if (action === 'deny') {
      await db.query(
        `UPDATE desk_items
           SET status='denied', denied_at=NOW(), operator_comment=$1, updated_at=NOW()
         WHERE id=$2 AND status IN ('pending','approved')`,
        [comment, id]
      )
    } else if (action === 'reset') {
      await db.query(
        `UPDATE desk_items
           SET status='pending', approved_at=NULL, denied_at=NULL,
               reported_at=NULL, operator_comment=NULL, report_message=NULL, updated_at=NOW()
         WHERE id=$1`,
        [id]
      )
    } else if (action === 'delete') {
      await db.query(`DELETE FROM desk_items WHERE id=$1`, [id])
    } else {
      return NextResponse.json({ error: 'bad action' }, { status: 400 })
    }

    return NextResponse.json({ ok: true })
  } finally { db.release() }
}
