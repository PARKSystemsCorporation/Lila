import { NextResponse } from 'next/server'
// Importing agent-tick here arms the server-side autonomy ticker as soon as
// Railway's first healthcheck lands, so Lila keeps running without a user.
import '@/lib/agent-tick'
import { getPool } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Railway watches this path (railway.toml → healthcheckPath). A non-200
// fails the deploy / trips the restart policy, so a missing or unreachable
// DATABASE_URL surfaces loudly instead of the app silently serving stale
// data from the wrong Postgres after a DB swap.
//   DB_NOT_CONFIGURED — DATABASE_URL is unset
//   DB_UNREACHABLE    — connection/probe failed or timed out
export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ ok: false, error: 'DB_NOT_CONFIGURED' }, { status: 503 })
  }

  try {
    const pool = getPool()
    const probe = (async () => {
      const db = await pool.connect()
      try {
        await db.query('SELECT 1')
      } finally {
        db.release()
      }
    })()
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('db probe timeout')), 5000)
    )
    await Promise.race([probe, timeout])
  } catch {
    return NextResponse.json({ ok: false, error: 'DB_UNREACHABLE' }, { status: 503 })
  }

  return NextResponse.json({ ok: true, ts: Date.now() })
}
