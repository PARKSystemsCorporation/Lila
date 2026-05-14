import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// GET /api/viewer/edges
//
// Public-viewer mirror of /api/picks/edges. Retired after the racing swap
// for the same reason (no per-game spread/edge in racing). Returns an empty
// games array; the consumer page degrades gracefully.

export async function GET() {
  return NextResponse.json({
    games: [],
    byDate: [],
    meta: {
      sport: 'RACING',
      retired: true,
      message: 'Per-game edges retired; subscribe-only signals now live on /api/picks.',
    },
  })
}
