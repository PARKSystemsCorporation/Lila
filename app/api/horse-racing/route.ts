import { NextResponse } from 'next/server'
import { getHorseDataService } from '@/lib/horse-racing/data-service'
import { attachSignals } from '@/lib/horse-racing/yield'
import { liveSources } from '@/lib/horse-racing/sources'

export const dynamic = 'force-dynamic'

// GET /api/horse-racing
//   → { races: RaceWithSignal[], status: {...}, generated_at }
//
// Returns today's racecards decorated with the derived yield signal.
// Benign empty payload when creds are missing — never 500 the page.

export async function GET() {
  const svc = getHorseDataService()
  try {
    const races = await svc.getTodayRacecards()
    const decorated = attachSignals(races)
    return NextResponse.json({
      races: decorated,
      status: {
        ...svc.status(),
        live_sources: liveSources().map(s => ({ name: s.name, kind: s.kind })),
      },
      generated_at: Date.now(),
    })
  } catch (e) {
    console.warn('[api/horse-racing] error:', e)
    return NextResponse.json({
      races: [],
      status: {
        ...svc.status(),
        live_sources: liveSources().map(s => ({ name: s.name, kind: s.kind })),
        error: String(e).slice(0, 120),
      },
      generated_at: Date.now(),
    })
  }
}
