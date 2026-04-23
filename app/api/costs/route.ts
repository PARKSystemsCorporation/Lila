import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { cfg } from '@/lib/config'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({
      today: 0,
      today_tokens: 0,
      calls_today: 0,
      mtd: 0,
      earnings_paid_mtd: 0,
      pending_max: 0,
      pending_count: 0,
      earnings_lifetime: 0,
      budget: cfg.DAILY_LLM_BUDGET_USD,
      byModule: [],
    })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const { rows: [today] } = await db.query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost,
              COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens,
              COUNT(*) AS calls
       FROM llm_usage
       WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`
    )

    const { rows: [mtd] } = await db.query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost
       FROM llm_usage
       WHERE created_at >= date_trunc('month', NOW() AT TIME ZONE 'UTC')`
    )

    // Confirmed payouts this month (not max bounty values — actual $ paid).
    const { rows: [earnings] } = await db.query(
      `SELECT COALESCE(SUM(payout), 0) AS total
       FROM security_reports
       WHERE paid_at >= date_trunc('month', NOW() AT TIME ZONE 'UTC')`
    )
    // Pending = submitted but not yet paid. Upper bound on what might arrive.
    const { rows: [pending] } = await db.query(
      `SELECT COALESCE(SUM(reward), 0) AS total, COUNT(*) AS n
       FROM security_reports
       WHERE status='submitted'`
    )
    const { rows: [lifetime] } = await db.query(
      'SELECT total_earned FROM lila_state WHERE id=1'
    )

    const { rows: byModule } = await db.query(
      `SELECT module,
              COALESCE(SUM(cost_usd), 0) AS cost,
              COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens
       FROM llm_usage
       WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')
       GROUP BY module
       ORDER BY cost DESC`
    )

    return NextResponse.json({
      today: parseFloat(today.cost),
      today_tokens: Number(today.tokens),
      calls_today: Number(today.calls),
      mtd: parseFloat(mtd.cost),
      earnings_paid_mtd: parseFloat(earnings.total),
      pending_max: parseFloat(pending.total),
      pending_count: Number(pending.n),
      earnings_lifetime: parseFloat(lifetime?.total_earned ?? '0'),
      budget: cfg.DAILY_LLM_BUDGET_USD,
      byModule: byModule.map(r => ({
        module: r.module,
        cost: parseFloat(r.cost),
        calls: Number(r.calls),
        tokens: Number(r.tokens),
      })),
    })
  } finally { db.release() }
}
