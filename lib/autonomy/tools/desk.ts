import type { PoolClient } from 'pg'
import { cfg } from '../../config'
import * as Desk from '../../desk'
import { processApprovedItems } from '../../desk'

// Desk tools the autonomy tree calls. These are thin — heavy lifting lives
// in lib/desk.ts so the file/submit/approve semantics stay centralized.

export interface DeskFileArgs {
  title: string
  body: string
  summary?: string
  category?: string
  payload?: unknown
  to_agent?: 'vega' | 'cipher' | 'scout' | 'ceelo'
  kind?: Desk.DeskKind
}

// File a desk item to the operator (direction='to_operator'). Used by
// LILA/OPERATOR/REQUEST and AUTONOMY/DESK leaves.
export async function fileToOperator(db: PoolClient, args: DeskFileArgs): Promise<{ id: number | null; logMessage: string }> {
  if (cfg.LILA_DRY_RUN) {
    return { id: null, logMessage: `[dry-run] desk.file_to_operator title="${args.title}"` }
  }
  if (!args.title || !args.body) {
    return { id: null, logMessage: 'desk.file_to_operator: missing title or body' }
  }
  const r = await Desk.submit(db, {
    from: 'lila',
    title: args.title,
    summary: args.summary,
    body: args.body,
    kind: args.kind ?? 'memo',
    direction: 'to_operator',
    category: args.category,
    payload: args.payload,
  })
  return { id: r.id, logMessage: `desk filed → operator #${r.id} "${args.title.slice(0, 50)}"` }
}

// File a desk item to a specific teammate (direction='to_agent'). Used by
// the few leaves that hand work over (e.g. CODE-REQUESTS escalating to a
// human via desk.file_to_operator is the v1 default — direct agent routing
// is here for completeness).
export async function fileToSelf(db: PoolClient, args: DeskFileArgs): Promise<{ id: number | null; logMessage: string }> {
  if (cfg.LILA_DRY_RUN) {
    return { id: null, logMessage: `[dry-run] desk.file_to_self title="${args.title}" to=${args.to_agent ?? 'lila'}` }
  }
  if (!args.title || !args.body) {
    return { id: null, logMessage: 'desk.file_to_self: missing title or body' }
  }
  const r = await Desk.submit(db, {
    from: 'lila',
    title: args.title,
    summary: args.summary,
    body: args.body,
    kind: args.kind ?? 'doc',
    // Default to filing back to operator if no explicit teammate target.
    direction: args.to_agent ? 'to_agent' : 'to_operator',
    toAgent: args.to_agent,
    category: args.category,
    payload: args.payload,
  })
  return { id: r.id, logMessage: `desk filed → ${args.to_agent ?? 'operator'} #${r.id}` }
}

// Read the operator → Lila inbox (top-level DESK leaves consume this).
export async function readInbox(db: PoolClient, args: { category?: string; limit?: number } = {}): Promise<{
  items: Awaited<ReturnType<typeof Desk.readInbound>>
  logMessage: string
}> {
  const items = await Desk.readInbound(db, { category: args.category, limit: args.limit ?? 5 })
  return { items, logMessage: `desk inbox: ${items.length} pending${args.category ? ' (' + args.category + ')' : ''}` }
}

// Mark an inbound desk item as serviced. The plan can also call
// fileToOperator with a follow-up before this step.
export async function markDone(db: PoolClient, args: { id: number; report: string }): Promise<{ logMessage: string }> {
  if (cfg.LILA_DRY_RUN) {
    return { logMessage: `[dry-run] desk.mark_done id=${args.id}` }
  }
  if (!args.id) return { logMessage: 'desk.mark_done: missing id' }
  await Desk.markServiced(db, args.id, args.report ?? 'serviced via autonomy tree')
  return { logMessage: `desk #${args.id} marked serviced` }
}

// Drain Lila's outbound approved items by reusing the legacy
// processApprovedItems flow. Returns the number reported so the plan step's
// result captures the outcome.
export async function processApprovals(db: PoolClient): Promise<{ logMessage: string }> {
  if (cfg.LILA_DRY_RUN) return { logMessage: '[dry-run] desk.process_approvals' }
  const r = await processApprovedItems(db)
  return { logMessage: r.logMessage ?? `desk.process_approvals: ${r.reported} reported` }
}
