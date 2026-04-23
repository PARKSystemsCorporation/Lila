import { NextResponse } from 'next/server'

const AGENT_URL = process.env.AGENT_SERVICE_URL

// Mock fallback used in local dev when the Python service isn't running
const MOCK_LOG = [
  { id: 5, message: 'Uptime monitor sweep initiated. 47 targets.', timestamp: Date.now() - 180_000, type: 'info' },
  { id: 4, message: 'Log analysis complete. Balance updated. Moving on.', timestamp: Date.now() - 420_000, type: 'success' },
  { id: 3, message: 'Rate limit hit. Backing off 30s. Fine.', timestamp: Date.now() - 540_000, type: 'warn' },
  { id: 2, message: 'Log analysis task accepted — $180 payout.', timestamp: Date.now() - 720_000, type: 'success' },
  { id: 1, message: 'Systems online. Scanning bounty board.', timestamp: Date.now() - 900_000, type: 'info' },
]

export async function GET() {
  // Proxy to Python agent service when configured
  if (AGENT_URL) {
    try {
      const res = await fetch(`${AGENT_URL}/agent`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw new Error(`Agent returned ${res.status}`)
      return NextResponse.json(await res.json())
    } catch (err) {
      console.error('[agent proxy]', err)
      return NextResponse.json({ error: 'Agent service unavailable' }, { status: 503 })
    }
  }

  // Local dev fallback — static mock so the UI is usable without the Python service
  return NextResponse.json({
    totalEarned: 1247.5,
    activeTasks: ['Uptime monitor sweep — 47 services'],
    lastBounty: { name: 'Log analysis — production incident trace', value: 180, time: Date.now() - 240_000 },
    log: MOCK_LOG,
  })
}
