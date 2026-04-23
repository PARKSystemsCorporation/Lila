import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createHash } from 'crypto'

const AUTH_HASH = createHash('sha256').update('58132133').digest('hex')

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Let auth endpoints, static assets, PWA files, and health check through
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/api/login') ||
    pathname.startsWith('/api/health') ||
    pathname.startsWith('/_next') ||
    pathname === '/manifest.json' ||
    pathname === '/sw.js' ||
    pathname.startsWith('/icon-')
  ) {
    return NextResponse.next()
  }

  const cookie = request.cookies.get('lila_auth')
  if (cookie?.value === AUTH_HASH) {
    return NextResponse.next()
  }

  return NextResponse.redirect(new URL('/login', request.url))
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
}
