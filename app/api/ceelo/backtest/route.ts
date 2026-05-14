import { NextResponse, type NextRequest } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { runBacktest, MAX_WINDOW_DAYS } from '@/lib/horse-racing/backtest'

export const dynamic = 'force-dynamic'

// GET /api/ceelo/backtest?from=YYYY-MM-DD&to=YYYY-MM-DD&intensity=6
//   → { data: BacktestSummary, status, generated_at }
//
// Replays the yield engine against ceelo_runner_odds + ceelo_results
// snapshots already collected by the C1/C2 phases. No upstream calls —
// the Racing API free tier is 1 RPS, so historical backfill is not
// viable; we use the data the loop has already persisted.

const DEFAULT_INTENSITY = 6

export async function GET(req: NextRequest) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({
      data: null,
      status: { db: false, error: 'no DATABASE_URL' },
      generated_at: Date.now(),
    })
  }
  const url = new URL(req.url)
  const fromStr = url.searchParams.get('from')
  const toStr   = url.searchParams.get('to')
  const intensityStr = url.searchParams.get('intensity')

  const to = toStr ? parseDate(toStr) : new Date()
  if (!to) return badRequest('bad `to`')
  const from = fromStr ? parseDate(fromStr) : new Date(to.getTime() - 7 * 86_400_000)
  if (!from) return badRequest('bad `from`')

  const intensity = clamp(intensityStr != null ? parseInt(intensityStr, 10) : DEFAULT_INTENSITY, 1, 10)
  if (!Number.isFinite(intensity)) return badRequest('bad `intensity`')

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const summary = await runBacktest(db, { from, to, intensity })
    return NextResponse.json({
      data: summary,
      status: { db: true, max_window_days: MAX_WINDOW_DAYS },
      generated_at: Date.now(),
    })
  } catch (e) {
    console.warn('[api/ceelo/backtest] error:', e)
    return NextResponse.json({
      data: null,
      status: { db: true, error: String(e).slice(0, 120) },
      generated_at: Date.now(),
    })
  } finally {
    db.release()
  }
}

// POST kept for backwards-compat with anything that scripted the old
// retire endpoint; same handler as GET.
export async function POST(req: NextRequest) {
  return GET(req)
}

function parseDate(s: string): Date | null {
  // Accept YYYY-MM-DD or full ISO; reject anything else.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : new Date(s)
  return Number.isFinite(d.getTime()) ? d : null
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return NaN
  return Math.max(lo, Math.min(hi, n))
}

function badRequest(message: string) {
  return NextResponse.json({
    data: null,
    status: { error: message },
    generated_at: Date.now(),
  })
}
