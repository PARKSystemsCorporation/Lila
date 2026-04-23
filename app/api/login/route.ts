import { NextResponse } from 'next/server'
import { createHash } from 'crypto'

export const dynamic = 'force-dynamic'

const PASSWORD = process.env.AUTH_PASSWORD ?? ''
const AUTH_HASH = createHash('sha256').update(PASSWORD).digest('hex')

const WINDOW_MS = 60_000
const MAX_ATTEMPTS = 5
const attempts = new Map<string, { count: number; resetAt: number }>()

function rateLimit(ip: string): boolean {
  const now = Date.now()
  const rec = attempts.get(ip)
  if (!rec || now > rec.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS })
    return true
  }
  if (rec.count >= MAX_ATTEMPTS) return false
  rec.count++
  return true
}

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? 'unknown'
}

export async function POST(req: Request) {
  if (!PASSWORD) {
    return NextResponse.json(
      { error: 'AUTH_PASSWORD not configured on the server.' },
      { status: 503 }
    )
  }

  const ip = clientIp(req)
  if (!rateLimit(ip)) {
    return NextResponse.json(
      { error: 'Too many attempts. Slow down.' },
      { status: 429, headers: { 'Retry-After': '60' } }
    )
  }

  const { password } = await req.json().catch(() => ({ password: '' }))
  const hash = createHash('sha256').update(String(password)).digest('hex')

  if (hash !== AUTH_HASH) {
    return NextResponse.json({ error: 'Wrong.' }, { status: 401 })
  }

  const res = NextResponse.json({ ok: true })
  res.cookies.set('lila_auth', AUTH_HASH, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
  })
  return res
}
