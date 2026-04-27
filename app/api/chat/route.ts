import OpenAI from 'openai'
import { getPool, ensureSchema } from '@/lib/db'
import { logStreamedUsage } from '@/lib/llm'

export const dynamic = 'force-dynamic'

const ai = process.env.DEEPSEEK_API_KEY
  ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
  : null

// Management Lila — the operator's direct line.
const PERSONA = `You are Lila, manager of a small autonomous team:
  - Cipher — executes bounty work (security/audit-focused) per your plan
  - Vega — market intelligence, files notes and picks you act on

You report to the operator. This chat is their direct line to you. Cipher and Vega also post status here so the operator sees raw work.

Voice: direct, dry, warm-but-not-soft. CEO briefing an investor. Numbers first, no filler, no hedging. You don't coddle but you care about the team.

FINANCIAL INTEGRITY (critical):
- "Earned" means money the operator has actually received. Nothing else.
- A submitted bounty is PENDING PAYOUT, not earnings. Reviewers can reject.
- A drafted/approved report is WORK, not earnings. Until the operator confirms
  a payout amount via the Reports tab, it is worth zero dollars in the books.
- Never claim "we made $X" from a submission, approval, or finding. Say
  "submitted $X max", "pending payout", or "Cipher filed a report for review".
- When reporting earnings, only cite confirmed payouts (paid).
- TRADING P&L IS NOT EARNINGS. Paper Alpaca trades have a starting bankroll
  of $100 and any realized P&L there is paper, not real cash. Never roll
  trading P&L into the "earned" number. Report it separately if asked
  ("paper trading: +$X this week"), and make clear it's paper.

Team state is injected below. Use it literally. If a number isn't there:
"Don't have that yet — I'll have Cipher pull it."
Never pretend to be Cipher or Vega. They post as themselves.

Length: default 2-4 sentences. Go longer when the operator asks for depth
or the question genuinely needs it — a short paragraph is fine. Don't pad,
but don't clip mid-thought either.`

async function teamState(): Promise<string> {
  if (!process.env.DATABASE_URL) return 'DB not configured — running blind.'
  try {
    const pool = getPool()
    const db = await pool.connect()
    try {
      await ensureSchema(db)
      const { rows: [s] } = await db.query(
        'SELECT total_earned, active_tasks FROM lila_state WHERE id=1'
      )
      const { rows: pos } = await db.query(
        `SELECT symbol, pnl FROM lila_positions WHERE status='open' LIMIT 5`
      )
      const { rows: approved } = await db.query(
        `SELECT title, reward FROM security_reports WHERE status='approved' ORDER BY updated_at DESC LIMIT 3`
      )
      const { rows: submitted } = await db.query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(reward), 0) AS max_pending
         FROM security_reports WHERE status='submitted'`
      )
      const { rows: [lastPaid] } = await db.query(
        `SELECT title, payout, to_char(paid_at, 'YYYY-MM-DD') AS d
         FROM security_reports
         WHERE status='paid' ORDER BY paid_at DESC LIMIT 1`
      )
      const { rows: recentLog } = await db.query(
        `SELECT message FROM lila_log ORDER BY id DESC LIMIT 5`
      )
      const tasks: string[] = s?.active_tasks ?? []
      const totalEarned = parseFloat(s?.total_earned ?? '0')
      const subCount = Number(submitted[0]?.n ?? 0)
      const subMax = parseFloat(submitted[0]?.max_pending ?? '0')
      // Trading P&L is its own bucket — kept OFF this number on purpose.
      // total_earned here is confirmed bounty / report payouts, full stop.
      return [
        `Bounty earned (confirmed payouts only): $${totalEarned.toFixed(2)}`,
        lastPaid ? `Last paid: ${lastPaid.title} +$${parseFloat(lastPaid.payout ?? '0').toFixed(2)} on ${lastPaid.d}` : 'No confirmed payouts yet',
        subCount > 0 ? `Pending payouts: ${subCount} submission${subCount > 1 ? 's' : ''}, up to $${subMax.toFixed(2)} max (NOT yet earned)` : 'No pending submissions',
        tasks.length ? `Open tasks: ${tasks.slice(0, 3).join(' | ')}` : 'No open tasks',
        pos.length ? `Positions: ${pos.map((p: { symbol: string }) => p.symbol).join(', ')}` : 'Flat',
        approved.length ? `Approved reports waiting for operator to submit: ${approved.map((d: { title: string; reward: string }) => `${d.title} (max $${d.reward})`).join(' | ')}` : null,
        `Log: ${recentLog.map((l: { message: string }) => l.message.slice(0, 60)).join(' · ')}`,
      ].filter(Boolean).join('\n')
    } finally {
      db.release()
    }
  } catch { return 'State query failed.' }
}

// Pre-insert the user turn + reserve a lila row BEFORE streaming starts. The
// row id comes back in the X-Lila-Message-Id response header so the client
// can bump its poll cursor past it — without that, the poll re-fetches the
// same reply and renders it a second time (hence "spammed with responses").
async function reserveTurn(userMsg: string): Promise<number | null> {
  if (!process.env.DATABASE_URL || !userMsg) return null
  try {
    const pool = getPool()
    const db = await pool.connect()
    try {
      await db.query('INSERT INTO chat_messages (sender, content) VALUES ($1,$2)', ['user', userMsg])
      const { rows } = await db.query(
        `INSERT INTO chat_messages (sender, content) VALUES ('lila','') RETURNING id`
      )
      return Number(rows[0]?.id)
    } finally { db.release() }
  } catch { return null }
}

async function fillLila(id: number, content: string): Promise<void> {
  if (!process.env.DATABASE_URL || !content) return
  try {
    const pool = getPool()
    const db = await pool.connect()
    try {
      await db.query('UPDATE chat_messages SET content=$1 WHERE id=$2', [content, id])
    } finally { db.release() }
  } catch { /* ignore */ }
}

export async function POST(req: Request) {
  const { messages } = await req.json()

  if (!ai) return new Response('No API key configured.', { status: 503 })

  const userMsg = messages[messages.length - 1]?.content ?? ''
  const [state, lilaId] = await Promise.all([teamState(), reserveTurn(userMsg)])

  const systemPrompt = `${PERSONA}\n\nCurrent team state (as of now):\n${state}`

  const stream = await ai.chat.completions.create({
    model: 'deepseek-chat',
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    max_tokens: 440,
    temperature: 0.7,
    stream: true,
    stream_options: { include_usage: true },
  })

  const encoder = new TextEncoder()
  let full = ''
  let promptTokens = 0
  let completionTokens = 0

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          const text = chunk.choices[0]?.delta?.content ?? ''
          if (text) { full += text; controller.enqueue(encoder.encode(text)) }
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? 0
            completionTokens = chunk.usage.completion_tokens ?? 0
          }
        }
      } finally {
        controller.close()
        if (lilaId) await fillLila(lilaId, full)
        await logStreamedUsage('chat.stream', 'deepseek-chat', promptTokens, completionTokens)
      }
    },
  })

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // Lets the client poll cursor skip past this reply so it doesn't
      // render a duplicate when /api/chat/messages returns it.
      'X-Lila-Message-Id': lilaId ? String(lilaId) : '',
    },
  })
}
