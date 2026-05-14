import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Retired after the racing swap. The previous-season ESPN walker for NBA /
// MLB / NFL lived here; it depended on lib/ceelo/legacy/espn.ts and
// lib/ceelo/legacy/ratings.ts.

export async function POST() {
  return NextResponse.json(
    { error: 'retired', message: 'Previous-season sportsbook seeder retired with the racing swap.' },
    { status: 410 }
  )
}
