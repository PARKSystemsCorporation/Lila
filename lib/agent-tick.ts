import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { getPool, ensureSchema } from './db'
import { TradingEngine } from './trading-engine'
import { AnalystLoop } from './analyst-loop'
import { LilaLoop } from './lila-loop'

// Single entry point for an autonomy tick. Called from /api/agent (user poll)
// and from the server-side ticker (instrumentation.ts). DB schema is lazy-init,
// a no-op after first call.

const HERMES_PROMPT = `You are Lila's Hermes synthesis module. Define one new skill she should acquire, based on bounty hunting + trading.

Respond with ONLY valid JSON — no markdown fences:
{
  "name": "snake_case_name",
  "description": "One sentence: what this skill does",
  "trigger": "One sentence: when Lila activates this skill",
  "code": "async function name(target: string): Promise<Result> {\\n  // Step 1...\\n}"
}

Focus on: web scraping, API testing, static analysis, contract auditing, recon, market analysis.`

async function maybeHermes(db: PoolClient): Promise<string | null> {
  if (!process.env.DEEPSEEK_API_KEY) return null
  try {
    const ai = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
    const res = await ai.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: HERMES_PROMPT },
        { role: 'user', content: 'Create a new skill now.' },
      ],
      max_tokens: 300,
      temperature: 0.85,
    })
    const raw = (res.choices[0]?.message?.content ?? '')
      .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
    const skill = JSON.parse(raw)
    if (!skill.name || !skill.description || !skill.trigger || !skill.code) return null
    await db.query(
      `INSERT INTO lila_skills (name, description, trigger, code)
       VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO NOTHING`,
      [
        String(skill.name).slice(0, 80),
        String(skill.description).slice(0, 300),
        String(skill.trigger).slice(0, 300),
        String(skill.code).slice(0, 2000),
      ]
    )
    return String(skill.name)
  } catch { return null }
}

export interface TickOutcome {
  ran: boolean
  logs: string[]
}

let inflight: Promise<TickOutcome> | null = null

export function runAgentTick(): Promise<TickOutcome> {
  // De-dupe overlapping callers (UI poll + server ticker racing each other).
  if (inflight) return inflight
  inflight = runAgentTickInner().finally(() => { inflight = null })
  return inflight
}

// ── Server-side autonomy ticker ───────────────────────────────────────────────
// Kicks in on the first import of this module (which only happens inside a
// Node.js route — never in Edge). That means Lila keeps running even when no
// client has the PWA open. Opt out by setting ENABLE_AUTONOMY_TICKER=false.

let tickerStarted = false
function startTicker() {
  if (tickerStarted) return
  if (process.env.ENABLE_AUTONOMY_TICKER === 'false') return
  // Skip during `next build` page-data collection.
  if (process.env.NEXT_PHASE === 'phase-production-build') return
  tickerStarted = true

  const interval = Number(process.env.AUTONOMY_TICK_MS ?? 30_000)
  setTimeout(() => {
    setInterval(() => {
      runAgentTick().catch(e => console.error('[autonomy] tick failed:', e))
    }, interval)
  }, 5_000)
  console.log(`[autonomy] ticker armed (every ${interval}ms)`)
}

startTicker()

async function runAgentTickInner(): Promise<TickOutcome> {
  if (!process.env.DATABASE_URL) return { ran: false, logs: ['No DATABASE_URL set — demo mode.'] }

  const pool = getPool()
  const db = await pool.connect()
  const logs: string[] = []

  try {
    await ensureSchema(db)

    const { rows: [s] } = await db.query(
      'SELECT tick_count FROM lila_state WHERE id = 1'
    )
    const tickCount = (s?.tick_count ?? 0) + 1
    await db.query('UPDATE lila_state SET tick_count=$1, updated_at=NOW() WHERE id=1', [tickCount])

    // 1. Position monitoring runs every tick (honors tight stops).
    const trader = new TradingEngine()
    const tradeResult = await trader.tick(db).catch(() => null)
    if (tradeResult && (tradeResult.action === 'bought' || tradeResult.action === 'sold')) {
      await db.query('INSERT INTO lila_log (message, type) VALUES ($1,$2)', [tradeResult.logMessage, tradeResult.logType])
      logs.push(tradeResult.logMessage)
    }

    // 2. Analyst loop — time-gated internally.
    const analyst = new AnalystLoop(db)
    const analystResult = await analyst.run().catch(() => null)
    if (analystResult) {
      await db.query('INSERT INTO lila_log (message, type) VALUES ($1,$2)', [analystResult.logMessage, analystResult.logType])
      logs.push(analystResult.logMessage)
    }

    // 3. Lila loop — time-gated internally.
    const lila = new LilaLoop(db)
    const lilaResult = await lila.run().catch((e: unknown) => ({
      step: 'BT0' as const,
      logMessage: `Lila loop error: ${String(e)}`,
      logType: 'warn' as const,
    }))
    if (lilaResult) {
      await db.query('INSERT INTO lila_log (message, type) VALUES ($1,$2)', [lilaResult.logMessage, lilaResult.logType])
      logs.push(lilaResult.logMessage)
    }

    // 4. Hermes every 20th server tick.
    if (tickCount % 20 === 0) {
      const name = await maybeHermes(db)
      const msg = name ? `Hermes: new skill — ${name}.` : 'Hermes synthesis attempted. No viable skill.'
      const type = name ? 'success' : 'info'
      await db.query('INSERT INTO lila_log (message, type) VALUES ($1,$2)', [msg, type])
      logs.push(msg)
    }

    return { ran: true, logs }
  } finally {
    db.release()
  }
}
