import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Retired after the racing swap. The ATS backtest walked closed NFL/NBA/MLB
// games using lib/ceelo/legacy/ratings.ts; the inputs (ceelo_games,
// closing_spread, ceelo_backtest table) no longer exist in the racing-shaped
// schema.

export async function POST() {
  return NextResponse.json(
    { error: 'retired', message: 'Sportsbook backtest retired with the racing swap.' },
    { status: 410 }
  )
}

export async function GET() {
  return NextResponse.json({ backtests: [], retired: true })
}
