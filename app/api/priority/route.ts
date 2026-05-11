import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { getPriority, setPriority, setMacroThesis } from '@/lib/priority'

export const dynamic = 'force-dynamic'

// GET  /api/priority
//   → { priority: string|null, macro_thesis: string|null }
//
// POST /api/priority { priority?: string|null, macro_thesis?: string|null, set_by?: string }
//   → { ok: true, priority, macro_thesis }
//
// Operator-facing sticky note + macro thesis for the agent fleet. Both
// fields are surfaced in Lila's autonomy context and prefixed onto every
// Cipher / Vega LLM call. Set fields you want to update; omit to leave
// untouched. Pass null to clear. middleware.ts gates this behind the
// operator cookie (same model as /api/desk and /api/autonomy).

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ priority: null, macro_thesis: null })
  }
  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const state = await getPriority(db)
    return NextResponse.json(state)
  } finally { db.release() }
}

export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'no db' }, { status: 503 })
  }
  const body = await req.json().catch(() => ({}))
  const setBy = String(body.set_by ?? 'operator').slice(0, 40) || 'operator'

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    if (Object.prototype.hasOwnProperty.call(body, 'priority')) {
      const p = body.priority
      if (p !== null && typeof p !== 'string') {
        return NextResponse.json({ error: 'priority must be string or null' }, { status: 400 })
      }
      await setPriority(db, p === null ? null : p.slice(0, 500), setBy)
    }
    if (Object.prototype.hasOwnProperty.call(body, 'macro_thesis')) {
      const t = body.macro_thesis
      if (t !== null && typeof t !== 'string') {
        return NextResponse.json({ error: 'macro_thesis must be string or null' }, { status: 400 })
      }
      await setMacroThesis(db, t === null ? null : t.slice(0, 1000), setBy)
    }

    const state = await getPriority(db)
    return NextResponse.json({ ok: true, ...state })
  } finally { db.release() }
}
