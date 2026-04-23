import type OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { getPool } from './db'
import { cfg } from './config'

// ── Centralized LLM wrapper ──────────────────────────────────────────────────
// All background LLM calls flow through here. Two jobs:
//   1. Log every call (module tag, tokens, USD cost) into llm_usage.
//   2. Enforce DAILY_LLM_BUDGET_USD — when today's total reaches the cap,
//      non-critical calls short-circuit with LLMBudgetExceeded. The operator
//      chat stream is exempt (it uses the raw client in /api/chat), so
//      replying to you never gets blocked by overnight research burn.

export class LLMBudgetExceeded extends Error {
  constructor(spent: number, cap: number) {
    super(`Daily LLM budget exceeded: $${spent.toFixed(4)} / $${cap.toFixed(2)}`)
    this.name = 'LLMBudgetExceeded'
  }
}

interface CallOpts {
  ai: OpenAI
  module: string
  messages: ChatCompletionMessageParam[]
  model?: string
  max_tokens: number
  temperature?: number
  // If true, skip the daily budget gate (operator-facing work only).
  critical?: boolean
}

export interface CallResult {
  content: string
  cost: number
  promptTokens: number
  completionTokens: number
}

// Cheap in-memory cache of today's spend; refreshed at most every 10s.
let spendCache: { at: number; value: number } | null = null

async function todaySpendUSD(): Promise<number> {
  if (spendCache && Date.now() - spendCache.at < 10_000) return spendCache.value
  if (!process.env.DATABASE_URL) return 0
  try {
    const pool = getPool()
    const db = await pool.connect()
    try {
      const { rows: [r] } = await db.query(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total
         FROM llm_usage
         WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`
      )
      const value = parseFloat(r?.total ?? '0')
      spendCache = { at: Date.now(), value }
      return value
    } finally { db.release() }
  } catch { return 0 }
}

function invalidateSpendCache() { spendCache = null }

export async function llmCall(opts: CallOpts): Promise<CallResult> {
  // Budget gate
  if (!opts.critical && cfg.DAILY_LLM_BUDGET_USD > 0) {
    const spent = await todaySpendUSD()
    if (spent >= cfg.DAILY_LLM_BUDGET_USD) {
      throw new LLMBudgetExceeded(spent, cfg.DAILY_LLM_BUDGET_USD)
    }
  }

  const model = opts.model ?? 'deepseek-chat'
  const res = await opts.ai.chat.completions.create({
    model,
    messages: opts.messages,
    max_tokens: opts.max_tokens,
    temperature: opts.temperature ?? 0.4,
  })
  const raw = res.choices[0]?.message?.content ?? ''
  const content = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  const promptTokens = res.usage?.prompt_tokens ?? 0
  const completionTokens = res.usage?.completion_tokens ?? 0
  const cost =
    (promptTokens / 1_000_000) * cfg.PRICE_IN_PER_M +
    (completionTokens / 1_000_000) * cfg.PRICE_OUT_PER_M

  // Log (best-effort; don't fail the call if DB is down)
  if (process.env.DATABASE_URL) {
    try {
      const pool = getPool()
      const db = await pool.connect()
      try {
        await db.query(
          `INSERT INTO llm_usage (module, model, prompt_tokens, completion_tokens, cost_usd)
           VALUES ($1,$2,$3,$4,$5)`,
          [opts.module, model, promptTokens, completionTokens, cost]
        )
      } finally { db.release() }
      invalidateSpendCache()
    } catch { /* logging best-effort */ }
  }

  return { content, cost, promptTokens, completionTokens }
}

// Helper for the streaming chat route: record usage after the stream
// finishes without blocking on budget.
export async function logStreamedUsage(
  module: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
): Promise<void> {
  if (!process.env.DATABASE_URL) return
  const cost =
    (promptTokens / 1_000_000) * cfg.PRICE_IN_PER_M +
    (completionTokens / 1_000_000) * cfg.PRICE_OUT_PER_M
  try {
    const pool = getPool()
    const db = await pool.connect()
    try {
      await db.query(
        `INSERT INTO llm_usage (module, model, prompt_tokens, completion_tokens, cost_usd)
         VALUES ($1,$2,$3,$4,$5)`,
        [module, model, promptTokens, completionTokens, cost]
      )
    } finally { db.release() }
    invalidateSpendCache()
  } catch { /* ignore */ }
}
