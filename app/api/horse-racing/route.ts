import { NextResponse, type NextRequest } from 'next/server'
import { createHash } from 'crypto'
import { getHorseDataService } from '@/lib/horse-racing/data-service'
import { attachSignals } from '@/lib/horse-racing/yield'
import { liveSources } from '@/lib/horse-racing/sources'
import type { RaceWithSignal } from '@/lib/horse-racing/types'

export const dynamic = 'force-dynamic'

// GET /api/horse-racing
//   → { data: RaceWithSignal[], races: RaceWithSignal[] (legacy), status, generated_at }
//
// Returns today's racecards decorated with the derived yield signal.
// Benign empty payload when creds are missing — never 500 the page.
// Emits a content ETag; honors If-None-Match → 304 so visibility-aware
// pollers don't re-download identical payloads.

export async function GET(req: NextRequest) {
  const svc = getHorseDataService()
  try {
    const races = await svc.getTodayRacecards()
    const decorated = attachSignals(races)
    const etag = contentEtag(decorated)
    const inm = req.headers.get('if-none-match')
    if (inm && inm === etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag } })
    }
    return NextResponse.json(
      {
        data: decorated,
        races: decorated,  // legacy alias — page.tsx still reads `races`
        status: {
          ...svc.status(),
          live_sources: liveSources().map(s => ({ name: s.name, kind: s.kind })),
        },
        generated_at: Date.now(),
      },
      { headers: { ETag: etag } },
    )
  } catch (e) {
    console.warn('[api/horse-racing] error:', e)
    return NextResponse.json({
      data: [],
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

// ETag from a stable per-race projection. Any odds tick that moves the
// top-yield runner or its edge will rotate the hash; identical content
// yields the same tag so the client's If-None-Match short-circuits.
function contentEtag(races: RaceWithSignal[]): string {
  const projection = [...races]
    .sort((a, b) => a.race_id.localeCompare(b.race_id))
    .map(r => [
      r.race_id,
      r.signal.top_runner?.horse_id ?? '',
      r.signal.top_runner?.odds_decimal ?? null,
      r.signal.top_runner?.edge_pct ?? null,
      r.signal.intensity,
      r.signal.velocity,
    ])
  const hash = createHash('sha1').update(JSON.stringify(projection)).digest('hex').slice(0, 16)
  return `W/"${hash}"`
}
