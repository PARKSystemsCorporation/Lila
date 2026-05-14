import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/artist/image/<id>
// Returns the raw image bytes for a row in artist_gallery. Cached
// aggressively (immutable) since each id maps 1:1 to bytes that never
// change.

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!process.env.DATABASE_URL) {
    return new Response('no db', { status: 503 })
  }
  const { id: idParam } = await params
  const id = Number(idParam)
  if (!id || !Number.isFinite(id)) {
    return new Response('bad id', { status: 400 })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const { rows: [row] } = await db.query(
      `SELECT image_b64, mime_type FROM artist_gallery WHERE id=$1`,
      [id]
    )
    if (!row) return new Response('not found', { status: 404 })
    const bytes = Buffer.from(row.image_b64, 'base64')
    return new Response(bytes, {
      headers: {
        'Content-Type': String(row.mime_type ?? 'image/png'),
        'Cache-Control': 'public, max-age=86400, immutable',
      },
    })
  } finally {
    db.release()
  }
}
