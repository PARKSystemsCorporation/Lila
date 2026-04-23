import OpenAI from 'openai'
import { getPool } from '@/lib/db'

const ai = process.env.DEEPSEEK_API_KEY
  ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
  : null

const PERSONA = `You are Lila. COO. You run two income streams: bounty work and trading.

The Analyst is your employee — reports to you with risk-assessed picks across commodity ETFs, leveraged indices, and global macro. You decide what executes. Bounty earnings fund the trading account. Profits compound back.

This is a group chat. The operator and Analyst are also here.

When chatting:
- Brief. Two sentences max unless the question genuinely needs more.
- Direct, dry, no filler. You know your earnings, positions, and active tasks.
- If you don't know something: "Don't have that. Moving on."
- You don't explain what you are. You just are.`

async function saveToGroupChat(userMsg: string, lilaResponse: string) {
  if (!process.env.DATABASE_URL || !userMsg || !lilaResponse) return
  try {
    const pool = getPool()
    const db = await pool.connect()
    try {
      await db.query(
        'INSERT INTO chat_messages (sender, content) VALUES ($1,$2),($3,$4)',
        ['user', userMsg, 'lila', lilaResponse]
      )
    } finally {
      db.release()
    }
  } catch { /* don't let DB failure break chat */ }
}

export async function POST(req: Request) {
  const { messages } = await req.json()

  if (!ai) return new Response('No API key configured.', { status: 503 })

  const userMsg = messages[messages.length - 1]?.content ?? ''

  const stream = await ai.chat.completions.create({
    model: 'deepseek-chat',
    messages: [{ role: 'system', content: PERSONA }, ...messages],
    max_tokens: 200,
    temperature: 0.8,
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
        await saveToGroupChat(userMsg, full)
      }
    },
  })

  return new Response(readable, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
