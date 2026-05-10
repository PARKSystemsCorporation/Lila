import type { PoolClient } from 'pg'
import OpenAI from 'openai'
import { llmCall, LLMBudgetExceeded } from './llm'

// Operator's desk — Lila / Cipher / Vega / Scout / Ceelo file docs here
// for the operator to review. Approval queues a 'read & report' task
// for Lila; denial captures a comment so the agent doesn't re-pitch
// the same dead-end direction.
//
// Agent side:
//   import * as Desk from '@/lib/desk'
//   await Desk.submit(db, { from: 'vega', title, summary, body, kind })
//
// Operator side: /api/desk + /api/desk/[id]/{approve,deny}.
//
// Lila reads approved items via processApprovedItems(db) — runs in the
// management-loop's high-priority path so reports show up in chat
// within one tick of approval.

export type DeskAgent = 'lila' | 'cipher' | 'vega' | 'scout' | 'ceelo'

export type DeskKind =
  | 'doc'        // generic markdown document
  | 'memo'       // short opinion / framing
  | 'pitch'      // proposed direction needing operator yes/no
  | 'finding'    // observation that may matter later
  | 'plan'       // multi-step plan
  | 'briefing'   // periodic data report (P&L, edges, etc)

// Three-way direction. 'to_operator' is the legacy agent→operator flow.
// 'to_lila' is the operator's inbox where structured requests are filed
// (code-request / help-request / web-post). 'to_agent' lets Lila route an
// item to a specific teammate (paired with to_agent='vega'|'cipher'|'ceelo').
export type DeskDirection = 'to_operator' | 'to_lila' | 'to_agent'

// Inbound (operator → Lila) request categories. Free-form on the column,
// but these are the v1 tree leaves.
export type DeskCategory = 'code-request' | 'help-request' | 'web-post' | string

export interface DeskSubmit {
  from: DeskAgent
  title: string
  summary?: string         // optional one-liner; falls back to first 140 chars of body
  body: string             // markdown
  kind?: DeskKind
  // Optional routing fields — defaults preserve legacy agent→operator flow.
  direction?: DeskDirection
  toAgent?: DeskAgent
  category?: DeskCategory
  payload?: unknown        // arbitrary JSON, e.g. {repo_path, instruction} for code-request
}

export async function submit(db: PoolClient, item: DeskSubmit): Promise<{ id: number }> {
  const summary = item.summary ?? firstLine(item.body, 140)
  const direction: DeskDirection = item.direction ?? 'to_operator'
  const { rows: [row] } = await db.query(
    `INSERT INTO desk_items
       (from_agent, to_agent, direction, category, payload,
        title, summary, body, kind, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
     RETURNING id`,
    [
      item.from,
      item.toAgent ?? null,
      direction,
      item.category ?? null,
      item.payload === undefined ? null : JSON.stringify(item.payload),
      item.title.slice(0, 200),
      summary,
      item.body,
      item.kind ?? 'doc',
    ]
  )
  return { id: Number(row.id) }
}

// Pending operator → Lila inbox (the three top-level DESK leaves).
export interface DeskInboundRow {
  id: number
  category: DeskCategory | null
  title: string
  summary: string | null
  body: string
  payload: unknown
  created_ts: number
}
export async function readInbound(
  db: PoolClient,
  opts: { category?: DeskCategory; limit?: number } = {}
): Promise<DeskInboundRow[]> {
  const params: unknown[] = []
  let where = `direction='to_lila' AND status='pending'`
  if (opts.category) { params.push(opts.category); where += ` AND category=$${params.length}` }
  params.push(opts.limit ?? 5)
  const { rows } = await db.query(
    `SELECT id, category, title, summary, body, payload,
            (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_ts
       FROM desk_items
      WHERE ${where}
      ORDER BY created_at ASC
      LIMIT $${params.length}`,
    params
  )
  return rows.map((r: { id: number; category: string | null; title: string; summary: string | null; body: string; payload: unknown; created_ts: string }) => ({
    id: Number(r.id),
    category: r.category,
    title: r.title,
    summary: r.summary,
    body: r.body,
    payload: r.payload,
    created_ts: Number(r.created_ts),
  }))
}

// Mark a desk item as serviced. Used by tools that close out an inbound
// request without going through the operator approve/deny flow.
export async function markServiced(
  db: PoolClient,
  id: number,
  reportMessage: string,
): Promise<void> {
  await db.query(
    `UPDATE desk_items
        SET status='reported', reported_at=NOW(), report_message=$2, updated_at=NOW()
      WHERE id=$1`,
    [id, reportMessage.slice(0, 1400)]
  )
}

// Recent denials for this agent — feed into the agent's prompt so they
// don't keep re-pitching directions the operator already killed.
export async function recentDenials(
  db: PoolClient,
  agent: DeskAgent,
  limit = 5,
): Promise<Array<{ title: string; comment: string | null }>> {
  const { rows } = await db.query(
    `SELECT title, operator_comment
     FROM desk_items
     WHERE from_agent = $1 AND status = 'denied'
       AND denied_at > NOW() - INTERVAL '30 days'
     ORDER BY denied_at DESC LIMIT $2`,
    [agent, limit]
  )
  return rows.map((r: { title: string; operator_comment: string | null }) => ({
    title: r.title,
    comment: r.operator_comment,
  }))
}

// Lila reads + reports on every approved desk item. Called from the
// management-loop priority path (after replyToOperator). One tick per
// item — keeps token costs predictable.
export async function processApprovedItems(db: PoolClient): Promise<{ reported: number; logMessage?: string }> {
  if (!process.env.DEEPSEEK_API_KEY) return { reported: 0 }
  const ai = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })

  // Don't stack desk reports on top of fresh chat activity. If Lila
  // posted in chat within the last 60 seconds (a reply to the operator,
  // a previous desk report, etc.) we let the queue wait one more tick.
  // Keeps the chat from feeling like Lila is firing 3 messages at once.
  const { rows: recentLila } = await db.query(
    `SELECT 1 FROM chat_messages
     WHERE thread='main' AND sender='lila' AND kind='message'
       AND created_at > NOW() - INTERVAL '60 seconds'
     LIMIT 1`
  )
  if (recentLila.length > 0) return { reported: 0 }

  const { rows } = await db.query(
    `SELECT id, from_agent, title, summary, body, kind
     FROM desk_items
     WHERE status='approved' AND reported_at IS NULL
     ORDER BY approved_at ASC
     LIMIT 1`
  )
  if (rows.length === 0) return { reported: 0 }

  let reported = 0
  for (const it of rows) {
    const prompt = `You are Lila, COO. The operator approved a desk item from ${String(it.from_agent).toUpperCase()} and wants you to read it and report back to chat what it says + what (if anything) to do about it.

Item kind: ${it.kind}
Title: ${it.title}

Body:
---
${String(it.body).slice(0, 6000)}
---

Reply in 2-4 sentences. CEO briefing-an-investor tone — direct, no filler. State (1) what it is, (2) the one thing the operator should pay attention to, (3) a concrete next action if there is one. If there's nothing actionable yet, say so.`

    let reply: string
    try {
      const res = await llmCall({
        ai,
        module: 'desk.read-and-report',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 280,
        temperature: 0.4,
      })
      reply = res.content.trim().slice(0, 1400)
    } catch (e) {
      if (e instanceof LLMBudgetExceeded) break
      reply = `Read ${it.title} but my LLM call hit an error — desk item ${it.id} stays approved, retry next tick.`
    }
    if (!reply) continue

    // Post to chat as a real conversational message + close out the item.
    await db.query(
      `INSERT INTO chat_messages (sender, content, thread, kind)
       VALUES ('lila', $1, 'main', 'message')`,
      [`📄 ${it.title} (from ${String(it.from_agent)}):\n${reply}`]
    )
    await db.query(
      `UPDATE desk_items
         SET status='reported', reported_at=NOW(), report_message=$1, updated_at=NOW()
       WHERE id=$2`,
      [reply, it.id]
    )
    reported++
  }

  return {
    reported,
    logMessage: reported > 0 ? `Lila reported on ${reported} desk item${reported === 1 ? '' : 's'}.` : undefined,
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function firstLine(s: string, max = 140): string {
  const t = s.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? s
  // Strip leading markdown # so the summary doesn't echo the title-line.
  return t.replace(/^#+\s*/, '').slice(0, max)
}
