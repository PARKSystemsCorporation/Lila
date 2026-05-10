import { randomUUID } from 'crypto'
import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { cfg } from '../config'
import { llmCall, LLMBudgetExceeded } from '../llm'
import { buildContext, renderContext, type AutonomyContext } from './context'
import { dispatch } from './dispatch'
import { pickPath, gateAllows } from './router'
import { resolveLeaf, PLAN_FORMAT_INSTRUCTIONS, type LeafNode, type ToolName } from './tree'

// Replaces ManagementLoop.run() when cfg.LILA_AUTONOMY_TREE is true.
//
//   1. resume: take the lowest pending step from lila_tasks, dispatch it.
//   2. else: route to a leaf (with cache), then generate + persist a plan.
//
// Two LLM calls when starting a plan; one tool dispatch per following tick.

// Wipes Lila's tree working state — the in-flight plan and the routing
// cache. Called from the /api/autonomy resume path so the next tick after
// an unpause re-routes fresh. Subloops keep their own internal step/phase.
export async function resetTreeState(db: PoolClient): Promise<void> {
  await db.query(`DELETE FROM lila_tasks WHERE status='pending'`)
  await db.query(
    `UPDATE management_state
        SET last_route_path=NULL, last_route_at=NULL, updated_at=NOW()
      WHERE id=1`
  )
}

const LILA_PERSONA =
  'You are Lila — desk manager at Park Systems. Voice: direct, lowercase-first, ' +
  'brutalist punctuation, no hedging. You produce tight, executable 10-step plans ' +
  "for the autonomy tree. Don't invent file paths, urls, or symbols not present " +
  'in the live context — leave them as clear placeholder strings instead.'

export interface AutonomyResult {
  logMessage: string
  logType: 'info' | 'success' | 'warn'
  posted: boolean
}

interface PlanStep {
  step_no: number
  description: string
  tool: ToolName
  args: Record<string, unknown>
}

export class AutonomyLoop {
  private db: PoolClient
  private ai: OpenAI | null

  constructor(db: PoolClient) {
    this.db = db
    this.ai = process.env.DEEPSEEK_API_KEY
      ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
      : null
  }

  async run(): Promise<AutonomyResult | null> {
    if (!this.ai) {
      return { logMessage: 'autonomy: DEEPSEEK_API_KEY missing — skipped.', logType: 'info', posted: false }
    }

    // 1. Resume in-progress plan, one step per tick.
    const resumed = await this.resumeStep()
    if (resumed) return resumed

    // 2. Otherwise, route + generate a fresh plan.
    let ctx: AutonomyContext
    try {
      ctx = await buildContext(this.db)
    } catch (e) {
      return { logMessage: `autonomy: context error ${String(e).slice(0, 100)}`, logType: 'warn', posted: false }
    }

    const cached = await this.cachedPath(ctx)
    let path: string[]
    let reason: string
    let leaf: LeafNode | null
    if (cached) {
      path = cached.path
      reason = `cached (${Math.round(cached.ageSec)}s old)`
      leaf = resolveLeaf(path)
    } else {
      try {
        const r = await pickPath(this.ai, renderContext(ctx))
        path = r.path
        reason = r.reason
        leaf = r.leaf
      } catch (e) {
        if (e instanceof LLMBudgetExceeded) {
          return { logMessage: 'autonomy: budget exceeded — routing deferred.', logType: 'info', posted: false }
        }
        return { logMessage: `autonomy: routing error ${String(e).slice(0, 100)}`, logType: 'warn', posted: false }
      }
    }

    if (!leaf) {
      return { logMessage: `autonomy: no leaf resolved (${reason})`, logType: 'warn', posted: false }
    }
    const now = new Date()
    if (!gateAllows(leaf.gate, now)) {
      return { logMessage: `autonomy: leaf ${leaf.id} gated out by TIME (${reason})`, logType: 'info', posted: false }
    }

    // Persist the route choice for caching.
    await this.recordRoute(path)

    // Generate + persist the 10-step plan.
    let plan: PlanStep[]
    try {
      plan = await this.generatePlan(leaf, ctx)
    } catch (e) {
      if (e instanceof LLMBudgetExceeded) {
        return { logMessage: 'autonomy: budget exceeded — plan-gen deferred.', logType: 'info', posted: false }
      }
      return { logMessage: `autonomy: plan-gen error ${String(e).slice(0, 100)}`, logType: 'warn', posted: false }
    }
    if (plan.length !== 10) {
      return { logMessage: `autonomy: plan-gen returned ${plan.length} steps for ${leaf.id} — discarded`, logType: 'warn', posted: false }
    }
    const planId = randomUUID()
    const branchPath = path.join('/')
    for (const step of plan) {
      await this.db.query(
        `INSERT INTO lila_tasks (plan_id, branch_path, step_no, description, tool, args, status)
         VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
        [planId, branchPath, step.step_no, step.description, step.tool, JSON.stringify(step.args ?? {})]
      )
    }
    return {
      logMessage: `autonomy: routed ${branchPath} (${reason}) — 10 steps queued`,
      logType: 'success',
      posted: true,
    }
  }

  private async resumeStep(): Promise<AutonomyResult | null> {
    const { rows: [row] } = await this.db.query(
      `SELECT id, plan_id, branch_path, step_no, description, tool, args
         FROM lila_tasks
        WHERE status='pending'
        ORDER BY plan_id, step_no
        LIMIT 1`
    )
    if (!row) return null
    const tool = String(row.tool) as ToolName
    const args = (row.args && typeof row.args === 'object') ? row.args as Record<string, unknown> : {}
    const result = await dispatch(this.db, tool, args)
    const status = result.ok ? 'done' : 'failed'
    await this.db.query(
      `UPDATE lila_tasks
          SET status=$2, result=$3, done_at=NOW()
        WHERE id=$1`,
      [row.id, status, result.logMessage.slice(0, 1400)]
    )
    return {
      logMessage: `autonomy: ${row.branch_path} step ${row.step_no}/10 ${status} — ${result.logMessage.slice(0, 100)}`,
      logType: result.ok ? 'info' : 'warn',
      posted: result.ok,
    }
  }

  private async cachedPath(ctx: AutonomyContext): Promise<{ path: string[]; ageSec: number } | null> {
    if (cfg.LILA_TREE_CACHE_SEC <= 0) return null
    // Skip cache when there's clearly new work (inbound desk or unanswered op).
    if (ctx.inbound.length > 0 || ctx.unanswered_operator) return null
    const { rows: [row] } = await this.db.query(
      `SELECT last_route_path, last_route_at,
              EXTRACT(EPOCH FROM (NOW() - last_route_at)) AS age_sec
         FROM management_state WHERE id=1`
    )
    if (!row?.last_route_path || !row?.last_route_at) return null
    const ageSec = Number(row.age_sec ?? 0)
    if (ageSec > cfg.LILA_TREE_CACHE_SEC) return null
    return { path: String(row.last_route_path).split('/').filter(Boolean), ageSec }
  }

  private async recordRoute(path: string[]): Promise<void> {
    await this.db.query(
      `UPDATE management_state SET last_route_path=$1, last_route_at=NOW(), updated_at=NOW() WHERE id=1`,
      [path.join('/')]
    )
  }

  private async generatePlan(leaf: LeafNode, ctx: AutonomyContext): Promise<PlanStep[]> {
    if (!this.ai) return []
    const allowed = leaf.tools.join(', ')
    const userPrompt = leaf.promptTemplate.replace('{CONTEXT}', renderContext(ctx))
      + `\n\nAllowed tools for this leaf: ${allowed}\n\n` + PLAN_FORMAT_INSTRUCTIONS
    const r = await llmCall({
      ai: this.ai,
      module: `autonomy.plan.${leaf.id.toLowerCase()}`,
      messages: [
        { role: 'system', content: LILA_PERSONA },
        { role: 'user',   content: userPrompt },
      ],
      max_tokens: 700,
      temperature: 0.4,
    })
    let parsed: { plan?: unknown }
    try { parsed = JSON.parse(r.content) } catch { return [] }
    if (!parsed || !Array.isArray((parsed as { plan?: unknown }).plan)) return []
    const allowedSet = new Set<ToolName>(leaf.tools)
    const plan: PlanStep[] = []
    for (let i = 0; i < (parsed.plan as unknown[]).length; i++) {
      const raw = (parsed.plan as unknown[])[i] as Record<string, unknown>
      const step_no = typeof raw.step_no === 'number' ? raw.step_no : i + 1
      const description = typeof raw.description === 'string' ? raw.description.slice(0, 240) : ''
      const tool = typeof raw.tool === 'string' ? raw.tool as ToolName : '' as ToolName
      const args = (raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args)) ? raw.args as Record<string, unknown> : {}
      if (!description || !allowedSet.has(tool)) continue
      plan.push({ step_no, description, tool, args })
    }
    // Renumber 1..N to keep ordering canonical.
    return plan.slice(0, 10).map((s, i) => ({ ...s, step_no: i + 1 }))
  }
}
