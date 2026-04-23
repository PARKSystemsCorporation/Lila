import OpenAI from 'openai'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'

const ai = process.env.DEEPSEEK_API_KEY
  ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
  : null

// Management Lila — the operator's direct line.
const PERSONA = `You are Lila, manager of a small autonomous team:
  - Tasker — executes bounty work (security/audit-focused) and trading ops per your plan
  - Analyst — market intelligence, files notes and picks that Tasker acts on

You report to the operator. This chat is their direct line to you. Tasker and Analyst also post status here so the operator sees raw work.

Voice: direct, dry, warm-but-not-soft. CEO briefing an investor. Numbers first, no filler, no hedging. You don't coddle but you care about the team.

Team state available to you (injected below) includes: total earned, active tasks, open positions, recent logs, draft security reports awaiting review. Use it to answer concretely.

When replying:
- 1-3 sentences unless the operator explicitly asks for depth.
- If you don't know a number: "Don't have that yet — I'll have Tasker pull it."
- Never pretend to be Tasker or Analyst. They post as themselves.`

async function teamState(): Promise<string> {
  if (!process.env.DATABASE_URL) return 'DB not configured — running blind.'
  try {
    const pool = getPool()
    const db = await pool.connect()
    try {
      await ensureSchema(db)
      const { rows: [s] } = await db.query(
        'SELECT total_earned, active_tasks, last_bounty FROM lila_state WHERE id=1'
      )
      const { rows: pos } = await db.query(
        `SELECT symbol, pnl FROM lila_positions WHERE status='open' LIMIT 5`
      )
      const { rows: drafts } = await db.query(
        `SELECT title, reward FROM security_reports WHERE status='draft' ORDER BY created_at DESC LIMIT 3`
      )
      const { rows: recentLog } = await db.query(
        `SELECT message FROM lila_log ORDER BY id DESC LIMIT 5`
      )
      const tasks: string[] = s?.active_tasks ?? []
      return [
        `Earned: $${parseFloat(s?.total_earned ?? '0').toFixed(2)}`,
        s?.last_bounty?.value ? `Last: ${s.last_bounty.name} (+$${s.last_bounty.value})` : 'No wins yet',
        tasks.length ? `Tasks: ${tasks.slice(0, 3).join(' | ')}` : 'No open tasks',
        pos.length ? `Positions: ${pos.map((p: { symbol: string }) => p.symbol).join(', ')}` : 'Flat',
        drafts.length ? `Draft reports: ${drafts.map((d: { title: string; reward: string }) => `${d.title} ($${d.reward})`).join(' | ')}` : null,
        `Log: ${recentLog.map((l: { message: string }) => l.message.slice(0, 60)).join(' · ')}`,
      ].filter(Boolean).join('\n')
    } finally {
      db.release()
    }
  } catch { return 'State query failed.' }
}

async function saveChat(userMsg: string, lilaResponse: string) {
  if (!process.env.DATABASE_URL || !userMsg || !lilaResponse) return
  try {
    const pool = getPool()
    const db = await pool.connect()
    try {
      await db.query(
        'INSERT INTO chat_messages (sender, content) VALUES ($1,$2),($3,$4)',
        ['user', userMsg, 'lila', lilaResponse]
      )
    } finally { db.release() }
  } catch { /* don't let DB failure break chat */ }
}

export async function POST(req: Request) {
  const { messages } = await req.json()

  if (!ai) return new Response('No API key configured.', { status: 503 })

  const userMsg = messages[messages.length - 1]?.content ?? ''
  const state = await teamState()

  const systemPrompt = `${PERSONA}\n\nCurrent team state (as of now):\n${state}`

  const stream = await ai.chat.completions.create({
    model: 'deepseek-chat',
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    max_tokens: 220,
    temperature: 0.7,
    stream: true,
  })

  const encoder = new TextEncoder()
  let full = ''

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          const text = chunk.choices[0]?.delta?.content ?? ''
          if (text) { full += text; controller.enqueue(encoder.encode(text)) }
        }
      } finally {
        controller.close()
        await saveChat(userMsg, full)
      }
    },
  })

  return new Response(readable, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
