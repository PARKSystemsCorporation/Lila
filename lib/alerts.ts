import type { PoolClient } from 'pg'
import * as Telegram from './channels/telegram'

// Telegram alerts for high-signal events. Runs once per agent-tick.
// Dedup is per-row via tg_alerted_at columns — once we ping for a
// row's first alert-eligible state, we never re-ping.
//
// Alert classes (all silent if Telegram isn't configured):
//   1. Bounty paid           security_reports.status='paid' + payout > 0
//   2. Scout draft ready     security_reports.source='scout' + status='approved'
//   3. Ceelo green flip      ceelo_picks.source='model' + confidence='high'
//   4. Trade closed (≥ \$10) lila_positions.status='closed' + |pnl| ≥ 10
//
// Each class is gated on tg_alerted_at IS NULL on the relevant row,
// then stamped after a successful Telegram send (or after a failed one
// — we don't retry indefinitely).

const TRADE_THRESHOLD = 10  // dollars

export interface AlertResult {
  sent: number
  failed: number
  classes: Record<string, number>
  logMessage?: string
  logType?: 'info' | 'success' | 'warn'
}

export async function runAlerts(db: PoolClient): Promise<AlertResult | null> {
  if (!Telegram.isConfigured()) return null

  let sent = 0
  let failed = 0
  const classes: Record<string, number> = { paid: 0, scout: 0, ceelo: 0, trade: 0 }

  // 1. Bounty paid
  const { rows: paid } = await db.query(
    `SELECT id, title, payout, platform_label
     FROM security_reports
     WHERE status = 'paid'
       AND payout IS NOT NULL AND payout > 0
       AND tg_alerted_at IS NULL
     ORDER BY paid_at DESC
     LIMIT 5`
  )
  for (const r of paid) {
    const msg = `🪙 Bounty PAID: $${parseFloat(r.payout).toFixed(2)} — ${r.title} (${r.platform_label})`
    await pingAndStamp(db, 'security_reports', r.id, msg)
      .then(ok => { ok ? sent++ : failed++ })
    classes.paid++
  }

  // 2. Scout draft ready (operator-actionable: approved + waiting to submit)
  const { rows: scout } = await db.query(
    `SELECT id, title, reward, platform_label
     FROM security_reports
     WHERE source = 'scout'
       AND status = 'approved'
       AND tg_alerted_at IS NULL
     ORDER BY updated_at DESC
     LIMIT 5`
  )
  for (const r of scout) {
    const msg = `📝 Scout draft ready: ${r.title} (≤ $${parseFloat(r.reward ?? '0').toFixed(0)} · ${r.platform_label}) — Lila approved, awaiting submit`
    await pingAndStamp(db, 'security_reports', r.id, msg)
      .then(ok => { ok ? sent++ : failed++ })
    classes.scout++
  }

  // 3. Ceelo high-confidence green flip
  const { rows: ceelo } = await db.query(
    `SELECT id, sport, game_label, side, model_spread, book_spread, edge_points
     FROM ceelo_picks
     WHERE source = 'model'
       AND confidence = 'high'
       AND status IN ('open','taken')
       AND tg_alerted_at IS NULL
     ORDER BY ABS(COALESCE(edge_points, 0)) DESC
     LIMIT 5`
  )
  for (const r of ceelo) {
    const edge = r.edge_points != null ? Number(r.edge_points).toFixed(1) : '?'
    const model = r.model_spread != null ? Number(r.model_spread).toFixed(1) : '?'
    const book  = r.book_spread  != null ? Number(r.book_spread).toFixed(1)  : '?'
    const msg = `🎯 Ceelo HIGH edge: ${r.sport} ${r.game_label} → ${r.side}\nmodel ${model} · book ${book} · edge ${edge} pt`
    await pingAndStamp(db, 'ceelo_picks', r.id, msg)
      .then(ok => { ok ? sent++ : failed++ })
    classes.ceelo++
  }

  // 4. Trade closed with meaningful P&L
  const { rows: trades } = await db.query(
    `SELECT id, symbol, direction, pnl, entry_price, target_price
     FROM lila_positions
     WHERE status = 'closed'
       AND pnl IS NOT NULL
       AND ABS(pnl) >= $1
       AND tg_alerted_at IS NULL
     ORDER BY closed_at DESC
     LIMIT 5`,
    [TRADE_THRESHOLD]
  )
  for (const r of trades) {
    const v = parseFloat(r.pnl)
    const sign = v >= 0 ? '+' : ''
    const icon = v >= 0 ? '📈' : '📉'
    const msg = `${icon} Trade closed: ${r.symbol} ${r.direction} ${sign}$${v.toFixed(2)}`
    await pingAndStamp(db, 'lila_positions', r.id, msg)
      .then(ok => { ok ? sent++ : failed++ })
    classes.trade++
  }

  if (sent === 0 && failed === 0) return null

  const parts: string[] = []
  if (classes.paid)  parts.push(`${classes.paid} paid`)
  if (classes.scout) parts.push(`${classes.scout} scout`)
  if (classes.ceelo) parts.push(`${classes.ceelo} ceelo`)
  if (classes.trade) parts.push(`${classes.trade} trade`)
  const summary = `Alerts: ${parts.join(' · ')}` + (failed > 0 ? ` (${failed} failed)` : '')

  return {
    sent, failed, classes,
    logMessage: summary,
    logType: failed > 0 ? 'warn' : 'success',
  }
}

// Send + stamp tg_alerted_at. Stamps even on failure so we don't loop
// forever on a broken Telegram config.
async function pingAndStamp(
  db: PoolClient,
  table: 'security_reports' | 'ceelo_picks' | 'lila_positions',
  id: number,
  msg: string,
): Promise<boolean> {
  const res = await Telegram.sendMessage(msg)
  await db.query(
    `UPDATE ${table} SET tg_alerted_at = NOW() WHERE id = $1`,
    [id]
  )
  return res.ok
}
