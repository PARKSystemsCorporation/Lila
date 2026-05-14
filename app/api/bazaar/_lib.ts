// Shared helpers for the /api/bazaar/* route handlers. Centralizes the
// HMAC check and the viewer-cookie lookup so each route stays terse.

import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import type { PoolClient } from 'pg'

import { verifyViewerCookie } from '@/lib/viewer-auth'
import { verifySignature } from '@/lib/bazaar/hmac'
import { getAgentByViewer, type BazaarAgent } from '@/lib/bazaar/agents'

export async function readJsonBody(req: Request): Promise<{ raw: string; json: unknown }> {
  const raw = await req.text()
  let json: unknown = null
  try { json = JSON.parse(raw) } catch { /* leave null */ }
  return { raw, json }
}

export function botGuard(req: Request, raw: string): NextResponse | null {
  const secret = process.env.BAZAAR_BOT_SECRET
  const sig = req.headers.get('x-bazaar-sig')
  const v = verifySignature(secret, sig, raw)
  if (v.ok) return null
  return NextResponse.json({ error: 'forbidden', reason: v.reason }, { status: 403 })
}

export interface ViewerContext {
  licenseKey: string
  viewerId: number
}

export async function viewerGuard(db: PoolClient): Promise<ViewerContext | NextResponse> {
  const secret = process.env.VIEWER_COOKIE_SECRET
  if (!secret) return NextResponse.json({ error: 'viewer auth not configured' }, { status: 503 })
  const cookie = (await cookies()).get('lila_viewer')?.value
  const payload = await verifyViewerCookie(cookie, secret)
  if (!payload) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const r = await db.query(`SELECT id FROM viewers WHERE license_key = $1`, [payload.key])
  if (r.rowCount === 0) return NextResponse.json({ error: 'viewer not found' }, { status: 404 })
  return { licenseKey: payload.key, viewerId: Number(r.rows[0].id) }
}

export async function viewerAgent(
  db: PoolClient,
  viewerId: number,
): Promise<BazaarAgent | null> {
  return getAgentByViewer(db, viewerId)
}
