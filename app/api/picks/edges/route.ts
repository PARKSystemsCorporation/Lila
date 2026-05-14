import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// GET /api/picks/edges
//
// Retired after the racing swap: there is no per-game spread/edge concept in
// thoroughbred-racing data. The legacy EdgeBoard UI (/theyield/edges) is
// kept alive but renders an empty grid until it gets a racing-shaped
// redesign (race × runner instead of game × team).
//
// New per-race signals are surfaced via /api/picks (one row per emitted
// racing pick) and /api/ceelo/diag (loop heartbeat).

export async function GET() {
  return NextResponse.json({
    games: [],
    byDate: [],
    meta: {
      sport: 'RACING',
      retired: true,
      message: 'Per-game edges retired; see /api/picks for per-race yields.',
    },
  })
}
