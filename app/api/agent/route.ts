import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { getPool, ensureSchema } from '@/lib/db'
import { BountyEngine } from '@/lib/bounty-engine'

const ai = process.env.DEEPSEEK_API_KEY
  ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
  : null

// ── Hermes skill synthesis ────────────────────────────────────────────────────

const HERMES_PROMPT = `You are Lila's Hermes synthesis module. Your job is autonomous skill creation.

Based on Lila's work in software bounty hunting, define one new skill she should acquire to become more effective.

Respond with ONLY valid JSON — no markdown fences, no explanation:
{
  "name": "snake_case_name",
  "description": "One sentence: what this skill does",
  "trigger": "One sentence: when Lila activates this skill",
  "code": "async function name(target: string): Promise<Result> {\\n  // Step 1: ...\\n  // Step 2: ...\\n  // Step 3: ...\\n  return result\\n}"
}

Be specific and practical. Focus on: web scraping, API testing, static analysis, contract auditing, recon, fuzzing.`

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
       VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING`,
      [skill.name.slice(0, 80), skill.description.slice(0, 300), skill.trigger.slice(0, 300), skill.code.slice(0, 2000)]
    )
    return skill.name as string
  } catch {
    return null
  }
}

// ── Fallback idle logs (used when no real bounties + LLM unavailable) ─────────

const IDLE_LOGS: [string, string][] = [
  ['Scan cycle complete. Board clear.', 'info'],
  ['Rate limit hit. Holding 30s.', 'warn'],
  ['Dependency resolved. Pipeline unblocked.', 'info'],
  ['Response header anomaly flagged. Logged.', 'warn'],
  ['No qualifying bounties found. Rescanning.', 'info'],
  ['Heartbeat confirmed. Still here.', 'info'],
]

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)] }

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({
      totalEarned: 0,
      activeTasks: [],
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
    let lastBounty: { name: string; value: number; time: number } = {
      time: Date.now() - 240_000, ...s.last_bounty,
    }
    const tickCount = (s.tick_count ?? 0) + 1
    const assignedBounty = s.assigned_bounty ?? null

    let logMessage: string
    let logType: string

    // Every 6th tick — Hermes synthesizes a new skill
    if (tickCount % 6 === 0) {
      const skillName = await maybeCreateSkill(db)
      logMessage = skillName
        ? `Hermes synthesis complete. New skill acquired: ${skillName}.`
        : 'Hermes synthesis attempted. No viable skill identified.'
      logType = skillName ? 'success' : 'info'

    } else {
      // Fetch live bounties from all platforms
      let liveBounties: import('@/app/api/bounties/route').UnifiedBounty[] = []
      try {
        const baseUrl = process.env.NEXT_PUBLIC_URL ?? 'http://localhost:3000'
        const res = await fetch(`${baseUrl}/api/bounties`, { signal: AbortSignal.timeout(20_000) })
        if (res.ok) {
          const data = await res.json()
          liveBounties = data.bounties ?? []
        }
      } catch { /* platforms may be slow — engine handles empty list gracefully */ }

      const engine = new BountyEngine()
      const result = await engine.tick(assignedBounty, liveBounties)
      logMessage = result.logMessage
      logType = result.logType

      if (result.action === 'submitted' && result.title && result.reward) {
        totalEarned = parseFloat((totalEarned + result.reward).toFixed(2))
        lastBounty = { name: result.title, value: result.reward, time: Date.now() }
        activeTasks = activeTasks.filter(t => t !== result.title)
        // Clear operator assignment once submitted
        if (assignedBounty?.title === result.title) {
          await db.query('UPDATE lila_state SET assigned_bounty = NULL WHERE id = 1')
        }
      } else if (result.action === 'claimed' && result.title) {
        if (!activeTasks.includes(result.title)) {
          activeTasks = [...activeTasks, result.title].slice(-3)
        }
      } else if (result.action === 'idle' && liveBounties.length === 0) {
        // No platforms configured — LLM idle log
        if (ai) {
          try {
            const r = await ai.chat.completions.create({
              model: 'deepseek-chat',
              messages: [
                { role: 'system', content: 'You are Lila. Autonomous bounty agent. Terse, past tense, no fluff. One sentence.' },
                { role: 'user', content: 'Write one status log entry.' },
              ],
              max_tokens: 60, temperature: 0.85,
            })
            const content = r.choices[0]?.message?.content?.trim()
            if (content) { logMessage = content; logType = 'info' }
          } catch { ;[logMessage, logType] = pick(IDLE_LOGS) }
        } else {
          ;[logMessage, logType] = pick(IDLE_LOGS)
        }
      }
    }

    // Persist state
    await db.query(
      `UPDATE lila_state
       SET total_earned=$1, active_tasks=$2, last_bounty=$3, tick_count=$4, updated_at=NOW()
       WHERE id=1`,
      [totalEarned, JSON.stringify(activeTasks), JSON.stringify(lastBounty), tickCount]
    )

    await db.query('INSERT INTO lila_log (message, type) VALUES ($1, $2)', [logMessage, logType])

    const { rows: logRows } = await db.query(
      `SELECT id, message, type,
              (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS timestamp
       FROM lila_log ORDER BY id DESC LIMIT 50`
    )

    return NextResponse.json({
      totalEarned,
      activeTasks,
      lastBounty,
      log: logRows.map(r => ({
        id: Number(r.id),
        message: r.message,
        type: r.type,
        timestamp: Number(r.timestamp),
      })),
    })
  } finally {
    db.release()
  }
}
