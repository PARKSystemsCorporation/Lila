import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import * as Telegram from '@/lib/channels/telegram'

export const dynamic = 'force-dynamic'

// GET  → whether Telegram creds are set
// POST → send a test message; returns {ok, error}
//
// On both paths we log the attempt into lila_log so the operator has a
// paper trail even without opening this endpoint directly.

export async function GET() {
  return NextResponse.json({
    configured: Telegram.isConfigured(),
    missing: [
      process.env.TELEGRAM_BOT_TOKEN ? null : 'TELEGRAM_BOT_TOKEN',
      process.env.TELEGRAM_CHAT_ID   ? null : 'TELEGRAM_CHAT_ID',
    ].filter(Boolean),
  })
}

export async function POST() {
  if (!Telegram.isConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'Telegram not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID on Railway.' },
      { status: 400 }
    )
  }

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  // Plain text, no parse_mode. Any stray underscore / asterisk would
  // otherwise trip Telegram's strict entity parser (e.g. "chat_id" as
  // italic with no closing delimiter → 400).
  const text = `Lila · Telegram test\nOperator triggered at ${stamp} UTC.\nIf you see this, the bot + chat_id are wired correctly.`
  const result = await Telegram.sendMessage(text)

  // Best-effort log so the operator can see results even from the Log panel.
  if (process.env.DATABASE_URL) {
    try {
      const pool = getPool()
      const db = await pool.connect()
      try {
        await ensureSchema(db)
        const msg = result.ok
          ? 'Telegram test message sent successfully.'
          : `Telegram test failed: ${result.error ?? 'unknown error'}`
        await db.query(
          'INSERT INTO lila_log (message, type) VALUES ($1,$2)',
          [msg, result.ok ? 'success' : 'warn']
        )
      } finally { db.release() }
    } catch { /* log is best-effort */ }
  }

  return NextResponse.json(result, { status: result.ok ? 200 : 502 })
}
