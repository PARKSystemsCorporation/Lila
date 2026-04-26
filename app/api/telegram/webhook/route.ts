import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Telegram bot inbound webhook.
//
// Setup (once, after first deploy):
//   POST /api/telegram/setup?url=https://<your-app>/api/telegram/webhook
// (or hit Telegram's setWebhook directly with that URL.)
//
// On each inbound update Telegram POSTs the update JSON to this route.
// We:
//   1. Verify the secret-token header (set during setWebhook).
//   2. Verify the chat_id matches the configured owner — only the
//      operator can DM Lila this way.
//   3. Drop the message text into chat_messages as
//      sender='user', thread='main', via='telegram'.
//   4. Return 200. The autonomy ticker's management loop will reply on
//      its next pass; the mirror step then sends Lila's reply back to
//      Telegram.

interface TelegramUpdate {
  update_id?: number
  message?: {
    message_id?: number
    from?: { id?: number; username?: string }
    chat?: { id?: number; type?: string }
    date?: number
    text?: string
  }
}

function ownerChatId(): string | null {
  // TELEGRAM_OWNER_CHAT_ID overrides; falls back to the existing
  // TELEGRAM_CHAT_ID used for outbound broadcasts. Either is fine for
  // a single-operator deploy.
  return process.env.TELEGRAM_OWNER_CHAT_ID
      ?? process.env.TELEGRAM_CHAT_ID
      ?? null
}

export async function POST(req: Request) {
  // 1. Secret-token gate. If TELEGRAM_WEBHOOK_SECRET is set and the
  //    incoming header doesn't match, refuse silently with a 200 so
  //    Telegram won't retry forever.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (secret) {
    const got = req.headers.get('x-telegram-bot-api-secret-token')
    if (got !== secret) {
      return NextResponse.json({ ok: true, ignored: 'bad secret' })
    }
  }

  let update: TelegramUpdate
  try { update = await req.json() } catch { return NextResponse.json({ ok: true, ignored: 'bad json' }) }

  const msg = update.message
  if (!msg?.text) return NextResponse.json({ ok: true, ignored: 'no text' })

  // 2. Owner-only gate.
  const owner = ownerChatId()
  if (!owner) return NextResponse.json({ ok: true, ignored: 'no owner configured' })
  const chatId = String(msg.chat?.id ?? '')
  if (chatId !== String(owner)) {
    return NextResponse.json({ ok: true, ignored: 'unauthorized chat' })
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ ok: true, ignored: 'no db' })
  }

  // 3. Persist as a main-thread user message tagged via='telegram'.
  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const text = msg.text.trim().slice(0, 4000)
    if (!text) return NextResponse.json({ ok: true, ignored: 'empty' })

    await db.query(
      `INSERT INTO chat_messages (sender, content, thread, via)
       VALUES ('user', $1, 'main', 'telegram')`,
      [text]
    )
    return NextResponse.json({ ok: true })
  } finally {
    db.release()
  }
}
