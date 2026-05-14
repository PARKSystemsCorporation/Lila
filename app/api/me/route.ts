import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function GET() {
  const c = await cookies()
  const password = process.env.AUTH_PASSWORD ?? ''
  const op = c.get('lila_auth')?.value
  const isOperator = !!(password && op && op === (await sha256Hex(password)))
  return NextResponse.json({ isOperator }, { headers: { 'cache-control': 'no-store' } })
}

export const dynamic = 'force-dynamic'
