import type { PoolClient } from 'pg'
import { recall, renderRecall, type RecallHits } from '../memory/retrieve'

// Build the context block fed into both the router and plan-gen prompts.
// Kept tight — ~1500 chars max — to keep token cost predictable.

export interface AutonomyContext {
  utc:                 string
  weekday:             string
  hour:                number
  // Operator's sticky note + open macro thesis. Same fields are also
  // prefixed onto every Cipher / Vega LLM call via lib/agent-brief.
  priority:            string | null
  macro_thesis:        string | null
  inbound:             { id: number; category: string | null; title: string; summary: string | null }[]
  approvals:           { id: number; from_agent: string; title: string }[]
  unanswered_operator: { ts: string; text: string } | null
  recent_chat:         { sender: string; kind: string; content: string }[]
  agent_status:        { agent: string; last_step_at: string | null; step: string | null; next_primary_set: boolean }[]
  active_plan:         { plan_id: string; branch_path: string; remaining: number } | null
  // ── Additive: KIRA-style recall against memory_episodes / memory_summaries
  // and the three correlation tiers. Existing fields above are unchanged so
  // anything reading the old shape keeps working.
  memory:              RecallHits | null
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export async function buildContext(db: PoolClient): Promise<AutonomyContext> {
  const now = new Date()

  const { rows: [pri] } = await db.query(
    `SELECT current_priority, macro_thesis FROM lila_state WHERE id=1`
  )

  const { rows: inbound } = await db.query(
    `SELECT id, category, title, summary
       FROM desk_items
      WHERE direction='to_lila' AND status='pending'
      ORDER BY created_at ASC LIMIT 5`
  )

  const { rows: approvals } = await db.query(
    `SELECT id, from_agent, title
       FROM desk_items
      WHERE status='approved' AND reported_at IS NULL
      ORDER BY approved_at ASC LIMIT 3`
  )

  // Unanswered operator message: most recent user msg in chat with no
  // 'lila' message after it. 20-min window matches replyToOperator's
  // existing lookback.
  const { rows: chatRows } = await db.query(
    `SELECT sender, kind, content,
            (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS ts
       FROM chat_messages
      WHERE thread='main' AND created_at > NOW() - INTERVAL '20 minutes'
      ORDER BY created_at ASC LIMIT 20`
  )
  let unanswered: AutonomyContext['unanswered_operator'] = null
  for (let i = chatRows.length - 1; i >= 0; i--) {
    const r = chatRows[i]
    // A Lila chat-visible reply after the candidate ends the search.
    if (r.sender === 'lila' && r.kind === 'message') break
    // Only true operator messages count. Teammate chatter (analyst/cipher/
    // scout/forge) must NOT route Lila to OPERATOR-MESSAGE.
    if (r.sender === 'user' && r.kind === 'message') {
      unanswered = { ts: new Date(Number(r.ts)).toISOString(), text: String(r.content).slice(0, 240) }
      break
    }
  }

  const recent_chat = chatRows.slice(-6).map((r: { sender: string; kind: string; content: string }) => ({
    sender: r.sender,
    kind: r.kind,
    content: String(r.content).slice(0, 160),
  }))

  const { rows: agents } = await db.query(
    `SELECT 'vega'   AS agent, last_step_at, step, next_primary IS NOT NULL AS np FROM analyst_state    WHERE id=1
     UNION ALL
     SELECT 'cipher' AS agent, last_step_at, step, next_primary IS NOT NULL AS np FROM lila_loop_state  WHERE id=1
     UNION ALL
     SELECT 'ceelo'  AS agent, last_run_at  AS last_step_at, NULL AS step, next_primary IS NOT NULL AS np FROM ceelo_state WHERE id=1`
  )

  const { rows: planRow } = await db.query(
    `SELECT plan_id, branch_path, COUNT(*)::int AS remaining
       FROM lila_tasks
      WHERE status='pending'
      GROUP BY plan_id, branch_path
      ORDER BY MIN(created_at) ASC LIMIT 1`
  )

  // Memory recall — derive a query string from what's hot right now (the
  // unanswered operator message + inbound titles + recent chat) and ask
  // memory.recall for relevant episodes/summaries/correlations. Wrapped in
  // try/catch so any memory failure degrades to an empty block, never
  // breaking context build.
  let memory: RecallHits | null = null
  try {
    const queryParts: string[] = []
    if (unanswered?.text) queryParts.push(unanswered.text)
    for (const r of inbound.slice(0, 3)) queryParts.push(String(r.title ?? ''))
    for (const c of chatRows.slice(-3)) queryParts.push(String((c as { content: string }).content ?? ''))
    const queryText = queryParts.filter(Boolean).join(' ').slice(0, 600)
    if (queryText) {
      memory = await recall(db, { text: queryText, k_correlations: 6, k_episodes: 4, k_summaries: 2 })
    }
  } catch {
    memory = null
  }

  return {
    utc:          now.toISOString(),
    weekday:      WEEKDAYS[now.getUTCDay()],
    hour:         now.getUTCHours(),
    priority:     pri?.current_priority ?? null,
    macro_thesis: pri?.macro_thesis     ?? null,
    inbound: inbound.map((r: { id: number; category: string | null; title: string; summary: string | null }) => ({
      id: Number(r.id), category: r.category, title: r.title, summary: r.summary,
    })),
    approvals: approvals.map((r: { id: number; from_agent: string; title: string }) => ({
      id: Number(r.id), from_agent: r.from_agent, title: r.title,
    })),
    unanswered_operator: unanswered,
    recent_chat,
    agent_status: agents.map((r: { agent: string; last_step_at: Date | null; step: string | null; np: boolean }) => ({
      agent: r.agent,
      last_step_at: r.last_step_at ? new Date(r.last_step_at).toISOString() : null,
      step: r.step,
      next_primary_set: !!r.np,
    })),
    active_plan: planRow[0]
      ? { plan_id: String(planRow[0].plan_id), branch_path: String(planRow[0].branch_path), remaining: Number(planRow[0].remaining) }
      : null,
    memory,
  }
}

// Compact text rendering for the context block in prompts.
export function renderContext(ctx: AutonomyContext): string {
  const lines: string[] = []
  lines.push(`utc=${ctx.utc} (${ctx.weekday} ${ctx.hour}h)`)
  lines.push(`priority: ${ctx.priority ?? 'none'}`)
  if (ctx.macro_thesis) lines.push(`macro_thesis: ${ctx.macro_thesis}`)
  lines.push(`active_plan=${ctx.active_plan ? `${ctx.active_plan.branch_path} (${ctx.active_plan.remaining} pending)` : 'none'}`)
  if (ctx.unanswered_operator) {
    lines.push(`unanswered_operator: "${ctx.unanswered_operator.text}"`)
  } else {
    lines.push(`unanswered_operator: none`)
  }
  if (ctx.inbound.length) {
    lines.push(`inbound desk (${ctx.inbound.length}):`)
    for (const r of ctx.inbound) lines.push(`  #${r.id} [${r.category ?? 'none'}] ${r.title}`)
  } else {
    lines.push(`inbound desk: empty`)
  }
  if (ctx.approvals.length) {
    lines.push(`approved-but-unreported (${ctx.approvals.length}):`)
    for (const r of ctx.approvals) lines.push(`  #${r.id} from ${r.from_agent}: ${r.title}`)
  }
  if (ctx.agent_status.length) {
    lines.push(`teammates:`)
    for (const a of ctx.agent_status) {
      lines.push(`  ${a.agent}: step=${a.step ?? '-'} last=${a.last_step_at ?? 'never'} next_primary_set=${a.next_primary_set}`)
    }
  }
  if (ctx.recent_chat.length) {
    lines.push(`recent chat:`)
    for (const c of ctx.recent_chat) lines.push(`  ${c.sender} (${c.kind}): ${c.content}`)
  }
  // Memory block (additive). Budget-deferred per plan: keep the existing
  // 1800-char overall cap; the memory block competes for that budget. After
  // observing real recall output we can revisit (raise the cap or make it
  // env-configurable).
  if (ctx.memory) {
    const block = renderRecall(ctx.memory, 600)
    if (block) lines.push(block)
  }
  return lines.join('\n').slice(0, 1800)
}
