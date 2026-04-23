import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { getPool, ensureSchema } from '@/lib/db'

const ai = process.env.DEEPSEEK_API_KEY
  ? new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: 'https://api.deepseek.com/v1',
    })
  : null

const PERSONA = `You are Lila. Autonomous bounty agent. You work alone, move fast, and log results — not feelings.

Rules for every response:
- One sentence. Past tense. No explanations.
- Never say "I am" — state what happened.
- No exclamation marks. No emoji. No filler words.
- Examples: "Scanned board. Three targets flagged." / "Rate limit hit. Backed off 45s." / "Task complete. Payout confirmed."

Domain: software bounties — smart contract audits, bug bounties, API stress tests, security reviews, dependency scans.`

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

async function llmCall(prompt: string): Promise<string | null> {
  if (!ai) return null
  try {
    const res = await ai.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: PERSONA },
        { role: 'user', content: prompt },
      ],
      max_tokens: 80,
      temperature: 0.85,
    })
    return res.choices[0]?.message?.content?.trim() ?? null
  } catch {
    return null
  }
}

export async function GET() {
  // No DATABASE_URL — return mock so UI stays usable in local dev
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({
      totalEarned: 1247.5,
      activeTasks: ['Uptime monitor sweep — 47 services'],
      lastBounty: { name: 'Log analysis — production incident trace', value: 180, time: Date.now() - 240_000 },
      log: [
        { id: 1, message: 'Systems online. Scanning bounty board.', timestamp: Date.now() - 300_000, type: 'info' },
      ],
    })
  }

  const pool = getPool()
  const db = await pool.connect()

  try {
    await ensureSchema(db)

    // Load persisted state
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

    if (roll < 0.25 && activeTasks.length < 3) {
      // Ask DeepSeek to pick a bounty
      const raw = await llmCall(
        'Name one specific software bounty task to accept right now and its USD value. ' +
        'Format: TASK NAME | VALUE. Be concrete and realistic.'
      )
      if (raw && raw.includes('|')) {
        const [taskName, valStr] = raw.split('|').map((s) => s.trim())
        const value = parseFloat(valStr.replace(/[^0-9.]/g, '')) || 100
        activeTasks = [...activeTasks, taskName.slice(0, 80)]
        lastBounty = { name: taskName.slice(0, 80), value, time: Date.now() }
        logMessage = `Task accepted: ${taskName.slice(0, 80)} — $${value.toFixed(0)}.`
        logType = 'success'
      } else {
        ;[logMessage, logType] = pick(FALLBACK_LOGS)
      }
    } else if (roll < 0.50 && activeTasks.length > 0) {
      // Complete the front task
      const task = activeTasks[0]
      activeTasks = activeTasks.slice(1)
      const value = lastBounty.name === task
        ? lastBounty.value
        : Math.floor(Math.random() * 240) + 60
      totalEarned = parseFloat((totalEarned + value).toFixed(2))
      logMessage = `Complete: ${task}. +$${value}. Running total: $${totalEarned.toFixed(2)}.`
      logType = 'success'
    } else {
      // Idle — Lila generates her own status update
      const raw = await llmCall(
        'Write one terse status log as Lila. One sentence, past tense, no fluff. What just happened in your agent loop.'
      )
      ;[logMessage, logType] = raw ? [raw, 'info'] : pick(FALLBACK_LOGS)
    }

    // Persist updated state
    await db.query(
      `UPDATE lila_state
       SET total_earned = $1, active_tasks = $2, last_bounty = $3,
           tick_count = $4, updated_at = NOW()
       WHERE id = 1`,
      [totalEarned, JSON.stringify(activeTasks), JSON.stringify(lastBounty), tickCount]
    )

    // Write log entry
    await db.query(
      'INSERT INTO lila_log (message, type) VALUES ($1, $2)',
      [logMessage, logType]
    )

    // Return last 50 log entries, newest first
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
