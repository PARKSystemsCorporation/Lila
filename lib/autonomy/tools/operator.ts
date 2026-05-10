import type { PoolClient } from 'pg'
import { cfg } from '../../config'
import * as Desk from '../../desk'

// Operator-facing tools. 'reply' posts a message to the main chat thread
// (the same channel replyToOperator writes into). 'request' files a desk
// item back to the operator (direction='to_operator').

export interface ReplyArgs {
  text: string
  via?: 'web' | 'telegram' | null
}

export async function reply(db: PoolClient, args: ReplyArgs): Promise<{ logMessage: string }> {
  const text = String(args.text ?? '').trim().slice(0, 1400)
  if (!text) return { logMessage: 'operator.reply: empty text' }
  if (cfg.LILA_DRY_RUN) {
    return { logMessage: `[dry-run] operator.reply "${text.slice(0, 60)}"` }
  }
  await db.query(
    `INSERT INTO chat_messages (sender, content, thread, kind, via)
     VALUES ('lila', $1, 'main', 'message', $2)`,
    [text, args.via ?? null]
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
