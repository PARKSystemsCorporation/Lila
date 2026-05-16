// Gated artifact download. Streams the operator-seeded file only when the
// signed-in viewer owns the item (a marketplace_purchases row exists).
//
// artifact_path is operator-controlled (seeded via scripts/seed-marketplace
// or admin SQL), never user input — but we still resolve it strictly inside
// MARKETPLACE_DIR and reject anything that escapes, as defence in depth.

import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { readFile } from 'fs/promises'
import path from 'path'
import { getPool, ensureSchema } from '@/lib/db'
import { verifyViewerCookie } from '@/lib/viewer-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const ARTIFACT_DIR = path.resolve(
  process.env.MARKETPLACE_DIR ?? path.join(process.cwd(), 'private', 'marketplace'),
)

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'database unavailable' }, { status: 503 })
  }
  const secret = process.env.VIEWER_COOKIE_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'viewer auth not configured' }, { status: 503 })
  }

  const viewerCookie = (await cookies()).get('lila_viewer')?.value
  const payload = await verifyViewerCookie(viewerCookie, secret)
  if (!payload) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { slug } = await params

  const pool = getPool()
  const db = await pool.connect()
  let artifactPath: string
  let title: string
  try {
    await ensureSchema(db)
    const v = await db.query(`SELECT id FROM viewers WHERE license_key = $1`, [payload.key])
    if (v.rowCount === 0) {
      return NextResponse.json({ error: 'viewer not found' }, { status: 404 })
    }
    const viewerId = Number(v.rows[0].id)

    const r = await db.query(
      `SELECT i.title, i.artifact_path
         FROM marketplace_items i
         JOIN marketplace_purchases p
           ON p.item_id = i.id AND p.viewer_id = $1
        WHERE i.slug = $2`,
      [viewerId, slug],
    )
    if (r.rowCount === 0) {
      // Not owned (or no such item) — don't distinguish, don't leak.
      return NextResponse.json({ error: 'not_entitled' }, { status: 403 })
    }
    artifactPath = String(r.rows[0].artifact_path)
    title = String(r.rows[0].title)
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 })
  } finally {
    db.release()
  }

  const resolved = path.resolve(ARTIFACT_DIR, artifactPath)
  if (resolved !== ARTIFACT_DIR && !resolved.startsWith(ARTIFACT_DIR + path.sep)) {
    return NextResponse.json({ error: 'artifact path invalid' }, { status: 500 })
  }

  let data: Buffer
  try {
    data = await readFile(resolved)
  } catch {
    return NextResponse.json({ error: 'artifact missing' }, { status: 404 })
  }

  const filename = `${slug}${path.extname(resolved) || '.zip'}`
  return new NextResponse(new Uint8Array(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(data.length),
      'X-Artifact-Title': encodeURIComponent(title),
      'Cache-Control': 'private, no-store',
    },
  })
}
