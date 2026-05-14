import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Retired after the racing swap. The NFL nflverse historical seeder + Elo
// walk lived here; both consumed lib/ceelo/legacy/nflverse.ts and
// lib/ceelo/legacy/ratings.ts. Restore by re-wiring those legacy modules
// against a resurrected ceelo_games table.

export async function POST() {
  return NextResponse.json(
    { error: 'retired', message: 'NFL historical seeder retired with the racing swap.' },
    { status: 410 }
  )
}
