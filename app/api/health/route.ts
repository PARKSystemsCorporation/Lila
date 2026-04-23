import { NextResponse } from 'next/server'
// Importing agent-tick here arms the server-side autonomy ticker as soon as
// Railway's first healthcheck lands, so Lila keeps running without a user.
import '@/lib/agent-tick'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ ok: true, ts: Date.now() })
}
