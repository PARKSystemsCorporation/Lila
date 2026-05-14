import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// GET /api/viewer/scoreboard
//
// Retired after the racing swap: the legacy scoreboard surfaced final NFL /
// NBA / MLB games with sport-specific score formatting. Racing results live
// in `ceelo_results`; a racing-shaped scoreboard would render race-by-race
// finishers instead of team-vs-team final scores. Returning an empty payload
// for now so the consuming pages don't crash.

export async function GET(req: Request) {
  const url = new URL(req.url)
  const sport = (url.searchParams.get('sport') ?? 'NBA').toUpperCase()
  return NextResponse.json({
    games: [],
    meta: {
      sport,
      retired: true,
      refreshed_ts: Date.now(),
      message: 'Scoreboard retired with the NFL/NBA/MLB sportsbook stack.',
    },
  })
}
