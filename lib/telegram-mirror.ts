import type { PoolClient } from 'pg'
import * as Telegram from './channels/telegram'

// Telegram bridge: if the operator's most recent main-thread message
// arrived via Telegram, mirror Lila's replies back to Telegram so the
// conversation stays in one place. Web messages cancel the bridge —
// once the operator types in the PWA, replies stop mirroring.
//
// Also: mirror Lila's PROACTIVE pings (no recent user message at all)
// to Telegram when the bridge was last engaged in the past hour.

const ACTIVE_WINDOW_MIN = 60

export interface MirrorResult {
  sent: number
  failed: number
  logMessage?: string
  logType?: 'info' | 'success' | 'warn'
}

export async function mirrorLilaToTelegram(db: PoolClient): Promise<MirrorResult | null> {
  if (!Telegram.isConfigured()) return null

  // Bridge is active if the most-recent main-thread user message in the
  // last hour came via Telegram. If the user typed from web after that,
  // mirror is paused.
  const { rows: [last] } = await db.query(
    `SELECT via, created_at
     FROM chat_messages
     WHERE thread='main' AND sender='user'
       AND created_at > NOW() - INTERVAL '${ACTIVE_WINDOW_MIN} minutes'
     ORDER BY id DESC LIMIT 1`
  )
  if (!last || last.via !== 'telegram') return null

  // Pull all unmirrored Lila replies in main thread that are newer than
  // that user message. Cap to avoid runaway batches.
  const { rows: pending } = await db.query(
    `SELECT id, content
     FROM chat_messages
     WHERE thread='main' AND sender='lila'
       AND mirrored_at IS NULL
       AND created_at >= $1
     ORDER BY id ASC LIMIT 5`,
    [last.created_at]
  )
  if (!pending.length) return null

  let sent = 0
  let failed = 0
  for (const m of pending) {
    const res = await Telegram.sendMessage(m.content)
    if (res.ok) {
      sent++
      await db.query(
        `UPDATE chat_messages SET mirrored_at=NOW() WHERE id=$1`, [m.id]
      )
    } else {
      failed++
      // Don't loop on the same message every tick — mark mirrored anyway
      // (the failure is logged; Bluesky/Telegram alert path picks it up).
      await db.query(
        `UPDATE chat_messages SET mirrored_at=NOW() WHERE id=$1`, [m.id]
      )
    }
  }

  if (sent === 0 && failed === 0) return null
  const logMessage = failed > 0
    ? `Telegram mirror: ${sent} sent, ${failed} failed.`
    : `Telegram mirror: ${sent} message${sent > 1 ? 's' : ''}.`
  return { sent, failed, logMessage, logType: failed > 0 ? 'warn' : 'info' }
}
