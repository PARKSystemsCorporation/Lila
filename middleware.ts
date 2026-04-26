import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const PASSWORD = process.env.AUTH_PASSWORD ?? ''

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

let authHashPromise: Promise<string> | null = null
function getAuthHash() {
  if (!authHashPromise) authHashPromise = sha256Hex(PASSWORD)
  return authHashPromise
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/api/login') ||
    pathname.startsWith('/api/health') ||
    // Telegram inbound webhook — Telegram's servers can't log in. The route
    // itself is gated on TELEGRAM_WEBHOOK_SECRET + owner chat_id.
    pathname.startsWith('/api/telegram/webhook') ||
    pathname.startsWith('/specs') ||
    pathname.startsWith('/_next') ||
    pathname === '/manifest.json' ||
    pathname === '/sw.js' ||
    pathname.startsWith('/icon-')
  ) {
    return NextResponse.next()
  }

  // Fail closed: if no password is configured, nobody gets in.
  if (!PASSWORD) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  const cookie = request.cookies.get('lila_auth')
  const authHash = await getAuthHash()
  if (cookie?.value === authHash) {
    return NextResponse.next()
  }

  return NextResponse.redirect(new URL('/login', request.url))
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
}
