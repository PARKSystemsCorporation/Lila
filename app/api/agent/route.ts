import { NextResponse } from 'next/server'
import OpenAI from 'openai'

export const dynamic = 'force-dynamic'

import type { PoolClient } from 'pg'
import { getPool, ensureSchema } from '@/lib/db'
import { BountyEngine } from '@/lib/bounty-engine'
import { TradingEngine } from '@/lib/trading-engine'
import { AnalystLoop } from '@/lib/analyst-loop'

const ai = process.env.DEEPSEEK_API_KEY
  ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
  : null

// ── Hermes skill synthesis ─────────────────────────────────────────────────────

const HERMES_PROMPT = `You are Lila's Hermes synthesis module. Your job is autonomous skill creation.

Based on Lila's work in bounty hunting and trading, define one new skill she should acquire.

Respond with ONLY valid JSON — no markdown fences, no explanation:
{
  "name": "snake_case_name",
  "description": "One sentence: what this skill does",
  "trigger": "One sentence: when Lila activates this skill",
  "code": "async function name(target: string): Promise<Result> {\\n  // Step 1: ...\\n  // Step 2: ...\\n  // Step 3: ...\\n  return result\\n}"
}

Focus on: web scraping, API testing, static analysis, contract auditing, recon, fuzzing, market analysis.`

async function maybeCreateSkill(db: PoolClient) {
  if (!ai) return null
  try {
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
      [skill.name.slice(0, 80), skill.description.slice(0, 300), skill.trigger.slice(0, 300), skill.code.slice(0, 2000)]
    )
    return skill.name as string
  } catch { return null }
}

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({
      totalEarned: 0, activeTasks: [],
      lastBounty: { name: 'None yet. Scanning platforms.', value: 0, time: Date.now() },
      log: [{ id: 1, message: 'No DATABASE_URL set — running in demo mode.', timestamp: Date.now(), type: 'warn' }],
    })
  }

  const pool = getPool()
  const db = await pool.connect()

  try {
    await ensureSchema(db)

    const { rows: [s] } = await db.query(
      'SELECT total_earned, active_tasks, last_bounty, tick_count, assigned_bounty FROM lila_state WHERE id = 1'
    )

    let totalEarned: number = parseFloat(s.total_earned)
    let activeTasks: string[] = s.active_tasks ?? []
    let lastBounty: { name: string; value: number; time: number } = { time: Date.now() - 240_000, ...s.last_bounty }
    const tickCount = (s.tick_count ?? 0) + 1
    const assignedBounty = s.assigned_bounty ?? null

    let logMessage: string
    let logType: string

    // ── Trading: runs every tick ───────────────────────────────────────────────
    const trader = new TradingEngine()
    const tradeResult = await trader.tick(db).catch(() => null)

    // ── Analyst loop: time-gated, runs one step when interval elapsed ──────────
    const analyst = new AnalystLoop(db)
    const analystResult = await analyst.run().catch(() => null)

    // ── Every 6th tick: Hermes ─────────────────────────────────────────────────
    if (tickCount % 6 === 0) {
      const skillName = await maybeCreateSkill(db)
      logMessage = skillName
        ? `Hermes: new skill acquired — ${skillName}.`
        : 'Hermes synthesis attempted. No viable skill identified.'
      logType = skillName ? 'success' : 'info'

    // ── Other ticks: bounty work ───────────────────────────────────────────────
    } else {
      let liveBounties: import('@/app/api/bounties/route').UnifiedBounty[] = []
      try {
        const baseUrl = process.env.NEXT_PUBLIC_URL ?? 'http://localhost:3000'
        const res = await fetch(`${baseUrl}/api/bounties`, { signal: AbortSignal.timeout(20_000) })
        if (res.ok) liveBounties = (await res.json()).bounties ?? []
      } catch { /* slow platforms handled gracefully */ }

      const engine = new BountyEngine()
      const result = await engine.tick(assignedBounty, liveBounties)
      logMessage = result.logMessage
      logType = result.logType

      if (result.action === 'submitted' && result.title && result.reward) {
        totalEarned = parseFloat((totalEarned + result.reward).toFixed(2))
        lastBounty = { name: result.title, value: result.reward, time: Date.now() }
        activeTasks = activeTasks.filter(t => t !== result.title)
        if (assignedBounty?.title === result.title) {
          await db.query('UPDATE lila_state SET assigned_bounty = NULL WHERE id = 1')
        }
      } else if (result.action === 'claimed' && result.title) {
        if (!activeTasks.includes(result.title)) activeTasks = [...activeTasks, result.title].slice(-3)
      } else if (result.action === 'idle' && liveBounties.length === 0) {
        const missing = ['SUPERTEAM_API_KEY', 'NEYNAR_API_KEY', 'CLAWTASKS_API_KEY'].filter(k => !process.env[k])
        logMessage = missing.length
          ? `No bounty platforms connected. Missing: ${missing.join(', ')}.`
          : 'All platforms returned empty. Check API keys.'
        logType = 'warn'
      }
    }

    // Notable trade or analyst events get their own log entry
    if (tradeResult && (tradeResult.action === 'bought' || tradeResult.action === 'sold')) {
      await db.query('INSERT INTO lila_log (message, type) VALUES ($1,$2)', [tradeResult.logMessage, tradeResult.logType])
    }
    if (analystResult) {
      await db.query('INSERT INTO lila_log (message, type) VALUES ($1,$2)', [analystResult.logMessage, analystResult.logType])
    }

    await db.query(
      `UPDATE lila_state SET total_earned=$1, active_tasks=$2, last_bounty=$3, tick_count=$4, updated_at=NOW() WHERE id=1`,
      [totalEarned, JSON.stringify(activeTasks), JSON.stringify(lastBounty), tickCount]
    )
    await db.query('INSERT INTO lila_log (message, type) VALUES ($1,$2)', [logMessage, logType])

    const { rows: logRows } = await db.query(
      `SELECT id, message, type, (EXTRACT(EPOCH FROM created_at)*1000)::bigint AS timestamp
       FROM lila_log ORDER BY id DESC LIMIT 50`
    )

    return NextResponse.json({
      totalEarned, activeTasks, lastBounty,
      log: logRows.map(r => ({ id: Number(r.id), message: r.message, type: r.type, timestamp: Number(r.timestamp) })),
    })
  } finally {
    db.release()
  }
}
