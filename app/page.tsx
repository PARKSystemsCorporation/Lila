// Root. Logged-out → public landing. Logged-in (viewer or operator) → member
// landing. Auth detection mirrors middleware.ts exactly.

import { cookies } from 'next/headers'
import { verifyViewerCookie } from '@/lib/viewer-auth'
import PublicLanding from './_components/public-landing'
import MemberLanding from './_components/member-landing'

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function isMember(): Promise<boolean> {
  const c = cookies()
  const password = process.env.AUTH_PASSWORD ?? ''
  const op = c.get('lila_auth')?.value
  if (password && op && op === (await sha256Hex(password))) return true
  const secret = process.env.VIEWER_COOKIE_SECRET ?? ''
  return !!(await verifyViewerCookie(c.get('lila_viewer')?.value, secret))
}

export default async function Root() {
  return (await isMember()) ? <MemberLanding /> : <PublicLanding />
}
