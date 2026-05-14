// Viewer-readable Skills Board feed.

import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { searchSkills } from '@/lib/bazaar/skills'
import { viewerGuard } from '../_lib'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const query = url.searchParams.get('q') ?? undefined
  const maxPrice = url.searchParams.get('max') ?? undefined

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const vg = await viewerGuard(db)
    if (vg instanceof NextResponse) return vg
    const skills = await searchSkills(db, { query, maxPriceLdgr: maxPrice, limit: 50 })
    return NextResponse.json({ skills })
  } finally {
    db.release()
  }
}
