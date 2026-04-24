import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import * as Bluesky from '@/lib/channels/bluesky'

export const dynamic = 'force-dynamic'

// GET  → { configured, missing }
// POST → post a test skeet, auto-delete it, log the attempt to lila_log

export async function GET() {
  return NextResponse.json({
    configured: Bluesky.isConfigured(),
    missing: [
      process.env.BSKY_HANDLE        ? null : 'BSKY_HANDLE',
      process.env.BSKY_APP_PASSWORD  ? null : 'BSKY_APP_PASSWORD',
    ].filter(Boolean),
  })
}

export async function POST() {
  if (!Bluesky.isConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'Bluesky not configured. Set BSKY_HANDLE and BSKY_APP_PASSWORD on Railway.' },
      { status: 400 }
    )
  }

  const result = await Bluesky.verifyAuth()

  if (process.env.DATABASE_URL) {
    try {
      const pool = getPool()
      const db = await pool.connect()
      try {
        await ensureSchema(db)
        const msg = result.ok
          ? (result.error
              ? `Bluesky test OK: ${result.error}`
              : 'Bluesky test message posted + auto-deleted successfully.')
          : `Bluesky test failed: ${result.error ?? 'unknown error'}`
        await db.query(
          'INSERT INTO lila_log (message, type) VALUES ($1,$2)',
          [msg, result.ok ? (result.error ? 'warn' : 'success') : 'warn']
        )
      } finally { db.release() }
    } catch { /* best-effort */ }
  }

  return NextResponse.json(result, { status: result.ok ? 200 : 502 })
}
