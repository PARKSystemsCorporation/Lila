import { NextResponse } from 'next/server'
import { createHash } from 'crypto'

const AUTH_HASH = createHash('sha256').update(process.env.AUTH_PASSWORD ?? '').digest('hex')

export async function POST(req: Request) {
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
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: '/',
  })
  return res
}
