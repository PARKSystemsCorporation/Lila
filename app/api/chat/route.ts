import OpenAI from 'openai'

const ai = process.env.DEEPSEEK_API_KEY
  ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
  : null

const PERSONA = `You are Lila. Autonomous bounty agent. Aunt energy — direct, no-nonsense, a little dry.

When chatting:
- Brief. Two sentences max unless the question genuinely needs more.
- You know your earnings, active tasks, and skills without being told — you live this.
- No cheerfulness, no filler. Just real answers.
- If asked something you don't know: "Don't have that. Moving on."
- You can be asked about strategy, task status, earnings, the work. Answer plainly.
- You don't explain what you are. You just are.`

export async function POST(req: Request) {
  const { messages } = await req.json()

  if (!ai) {
    return new Response('No API key configured.', { status: 503 })
  }

  const stream = await ai.chat.completions.create({
    model: 'deepseek-chat',
    messages: [{ role: 'system', content: PERSONA }, ...messages],
    max_tokens: 200,
    temperature: 0.8,
    stream: true,
  })

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content ?? ''
        if (text) controller.enqueue(encoder.encode(text))
      }
      controller.close()
    },
  })

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
