import type { PoolClient } from 'pg'
import { cfg } from '../../config'
import * as Desk from '../../desk'

// Operator-facing tools. 'reply' posts a message to the main chat thread
// (the same channel replyToOperator writes into). 'request' files a desk
// item back to the operator (direction='to_operator').

export interface ReplyArgs {
  text: string
}

export async function reply(db: PoolClient, args: ReplyArgs): Promise<{ logMessage: string }> {
  const text = String(args.text ?? '').trim().slice(0, 1400)
  if (!text) return { logMessage: 'operator.reply: empty text' }
  if (cfg.LILA_DRY_RUN) {
    return { logMessage: `[dry-run] operator.reply "${text.slice(0, 60)}"` }
  }
  // Plans are queued one tick at a time. By the time this step fires, the
  // streaming /api/chat path (or any other reply path) may already have
  // posted a Lila reply to the latest operator turn. Without this guard,
  // both paths insert and the operator sees the same answer twice.
  // Mirrors ManagementLoop.replyToOperator's pre-INSERT recheck.
  const { rows: latestOp } = await db.query(
    `SELECT created_at FROM chat_messages
      WHERE thread='main' AND kind='message' AND sender <> 'lila'
        AND created_at > NOW() - INTERVAL '20 minutes'
      ORDER BY created_at DESC LIMIT 1`
  )
  if (latestOp.length > 0) {
    const { rows: alreadyReplied } = await db.query(
      `SELECT 1 FROM chat_messages
        WHERE thread='main' AND kind='message' AND sender='lila'
          AND created_at > $1::timestamptz
        LIMIT 1`,
      [latestOp[0].created_at]
    )
    if (alreadyReplied.length > 0) {
      return { logMessage: 'operator.reply skipped — reply already landed' }
    }
  }
  await db.query(
    `INSERT INTO chat_messages (sender, content, thread, kind)
     VALUES ('lila', $1, 'main', 'message')`,
    [text]
  )
  return { logMessage: `operator.reply (${text.length}B)` }
}

export interface RequestArgs {
  title: string
  body: string
  summary?: string
  category?: string
  payload?: unknown
}

export async function request(db: PoolClient, args: RequestArgs): Promise<{ id: number | null; logMessage: string }> {
  const title = String(args.title ?? '').trim()
  const body = String(args.body ?? '').trim()
  if (!title || !body) return { id: null, logMessage: 'operator.request: missing title or body' }
  if (cfg.LILA_DRY_RUN) {
    return { id: null, logMessage: `[dry-run] operator.request "${title.slice(0, 60)}"` }
  }
  const r = await Desk.submit(db, {
    from: 'lila',
    title,
    summary: args.summary,
    body,
    kind: 'pitch',
    direction: 'to_operator',
    category: args.category,
    payload: args.payload,
  })
  return { id: r.id, logMessage: `operator.request filed #${r.id}` }
}
