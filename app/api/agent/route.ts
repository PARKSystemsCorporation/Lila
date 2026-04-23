import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { getPool, ensureSchema } from '@/lib/db'

const ai = process.env.DEEPSEEK_API_KEY
  ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
  : null

const PERSONA = `You are Lila. Autonomous bounty agent. You work alone, move fast, and log results — not feelings.

Rules for all output:
- One sentence. Past tense. No explanations.
- Never "I am" — state what happened.
- No exclamation marks. No emoji. No filler.
- Examples: "Scanned board. Three targets flagged." / "Rate limit hit. Backed off 45s." / "Task complete. Payout confirmed."

Domain: software bounties — smart contract audits, bug bounties, API stress tests, security reviews, dependency scans.`

const HERMES_PROMPT = `You are Lila's Hermes synthesis module. Your job is autonomous skill creation.

Based on Lila's work in software bounty hunting, define one new skill she should acquire to become more effective.

Respond with ONLY valid JSON — no markdown fences, no explanation:
{
  "name": "snake_case_name",
  "description": "One sentence: what this skill does",
  "trigger": "One sentence: when Lila activates this skill",
  "code": "async function name(target: string): Promise<Result> {\n  // Step 1: ...\n  // Step 2: ...\n  // Step 3: ...\n  return result\n}"
}

Be specific and practical. Focus on: web scraping, API testing, static analysis, contract auditing, recon, fuzzing.`

const FALLBACK_LOGS: [string, string][] = [
  ['Scan cycle complete. Board clear.', 'info'],
  ['Rate limit hit. Holding 30s.', 'warn'],
  ['Three threads active. Monitoring.', 'info'],
  ['Dependency resolved. Pipeline unblocked.', 'info'],
  ['Response header anomaly flagged. Logged.', 'warn'],
  ['Queue checked. Nothing worth taking yet.', 'info'],
  ['Heartbeat confirmed. Still here.', 'info'],
  ['Idle mode. Watching the board.', 'info'],
  ['Auth sweep complete. No anomalies.', 'info'],
  ['Memory sync complete.', 'info'],
]

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

async function llmCall(prompt: string, systemOverride?: string): Promise<string | null> {
  if (!ai) return null
  try {
    const res = await ai.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemOverride ?? PERSONA },
        { role: 'user', content: prompt },
      ],
      max_tokens: 300,
      temperature: 0.85,
    })
    return res.choices[0]?.message?.content?.trim() ?? null
  } catch {
    return null
  }
}

async function maybeCreateSkill(db: Awaited<ReturnType<ReturnType<typeof getPool>['connect']>>) {
  const raw = await llmCall('Create a new skill now.', HERMES_PROMPT)
  if (!raw) return null

  // Strip markdown fences if model wraps in them
  const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()

  let skill: { name: string; description: string; trigger: string; code: string }
  try {
    skill = JSON.parse(json)
  } catch {
    return null
  }

  if (!skill.name || !skill.description || !skill.trigger || !skill.code) return null

  try {
    await db.query(
      `INSERT INTO lila_skills (name, description, trigger, code)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO NOTHING`,
      [skill.name.slice(0, 80), skill.description.slice(0, 300), skill.trigger.slice(0, 300), skill.code.slice(0, 2000)]
    )
    return skill.name
  } catch {
    return null
  }
}

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({
      totalEarned: 1247.5,
      activeTasks: ['Uptime monitor sweep — 47 services'],
      lastBounty: { name: 'Log analysis — production incident trace', value: 180, time: Date.now() - 240_000 },
      log: [{ id: 1, message: 'Systems online. No DATABASE_URL set — running in demo mode.', timestamp: Date.now(), type: 'warn' }],
    })
  }

  const pool = getPool()
  const db = await pool.connect()

  try {
    await ensureSchema(db)

    const { rows: [s] } = await db.query(
      'SELECT total_earned, active_tasks, last_bounty, tick_count FROM lila_state WHERE id = 1'
    )

    let totalEarned: number = parseFloat(s.total_earned)
    let activeTasks: string[] = s.active_tasks ?? []
    let lastBounty: { name: string; value: number; time: number } = {
      time: Date.now() - 240_000,
      ...s.last_bounty,
    }
    const tickCount = (s.tick_count ?? 0) + 1

    let logMessage: string
    let logType: string

    const roll = Math.random()

    // Every 6th tick — Hermes synthesizes a new skill autonomously
    if (tickCount % 6 === 0) {
      const skillName = await maybeCreateSkill(db)
      logMessage = skillName
        ? `Hermes synthesis complete. New skill acquired: ${skillName}.`
        : 'Hermes synthesis attempted. No viable skill identified.'
      logType = skillName ? 'success' : 'info'

    } else if (roll < 0.25 && activeTasks.length < 3) {
      const raw = await llmCall(
        'Name one specific software bounty task to accept right now and its USD value. ' +
        'Format: TASK NAME | VALUE. Be concrete and realistic.'
      )
      if (raw && raw.includes('|')) {
        const [taskName, valStr] = raw.split('|').map((x) => x.trim())
        const value = parseFloat(valStr.replace(/[^0-9.]/g, '')) || 100
        activeTasks = [...activeTasks, taskName.slice(0, 80)]
        lastBounty = { name: taskName.slice(0, 80), value, time: Date.now() }
        logMessage = `Task accepted: ${taskName.slice(0, 80)} — $${value.toFixed(0)}.`
        logType = 'success'
      } else {
        ;[logMessage, logType] = pick(FALLBACK_LOGS)
      }

    } else if (roll < 0.50 && activeTasks.length > 0) {
      const task = activeTasks[0]
      activeTasks = activeTasks.slice(1)
      const value =
        lastBounty.name === task ? lastBounty.value : Math.floor(Math.random() * 240) + 60
      totalEarned = parseFloat((totalEarned + value).toFixed(2))
      logMessage = `Complete: ${task}. +$${value}. Running total: $${totalEarned.toFixed(2)}.`
      logType = 'success'

    } else {
      const raw = await llmCall(
        'Write one terse status log as Lila. One sentence, past tense, no fluff. What just happened in your agent loop.'
      )
      ;[logMessage, logType] = raw ? [raw, 'info'] : pick(FALLBACK_LOGS)
    }

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
      log: logRows.map((r) => ({
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
