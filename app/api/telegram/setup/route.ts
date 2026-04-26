import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// One-shot helper to register the Telegram webhook.
//
// Usage (after deploy):
//   POST /api/telegram/setup?url=https://<your-app>/api/telegram/webhook
//   GET  /api/telegram/setup           → shows the current webhook info
//   DELETE /api/telegram/setup         → unregister
//
// Auth: gated on AUTH_PASSWORD via the existing middleware. Don't expose
// this route to anonymous traffic; the middleware already requires login.

const TG = (token: string, method: string) =>
  `https://api.telegram.org/bot${token}/${method}`

export async function GET() {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN not set' }, { status: 400 })
  const res = await fetch(TG(token, 'getWebhookInfo'))
  const json = await res.json().catch(() => null)
  return NextResponse.json(json ?? { error: 'no response' })
}

export async function POST(req: Request) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN not set' }, { status: 400 })

  const url = new URL(req.url).searchParams.get('url')
  if (!url) return NextResponse.json({ error: 'url query param required' }, { status: 400 })

  const body: Record<string, unknown> = {
    url,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  }
  if (process.env.TELEGRAM_WEBHOOK_SECRET) {
    body.secret_token = process.env.TELEGRAM_WEBHOOK_SECRET
  }

  const res = await fetch(TG(token, 'setWebhook'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return NextResponse.json(json ?? { error: 'no response' })
}

export async function DELETE() {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN not set' }, { status: 400 })
  const res = await fetch(TG(token, 'deleteWebhook'), { method: 'POST' })
  const json = await res.json().catch(() => null)
  return NextResponse.json(json ?? { error: 'no response' })
}
