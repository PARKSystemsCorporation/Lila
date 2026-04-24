import * as Alpaca from './platforms/alpaca'
import type { PoolClient } from 'pg'

// Sizing is agnostic — up to 75% of buying power per pick so a $30 account
// can take a $20 trade. The safety rails are the *stops*, not position size.
const MAX_POSITION_PCT = 0.75
const MIN_NOTIONAL = 1.00
// Default tight stop when a pick doesn't carry one. Individual picks can
// override via stop_loss (Lila's plans usually do).
const DEFAULT_STOP_PCT = 3

export interface TradingResult {
  action: 'bought' | 'sold' | 'monitored' | 'idle' | 'error'
  symbol?: string
  notional?: number
  pnl?: number
  logMessage: string
  logType: 'info' | 'success' | 'warn'
}

export class TradingEngine {
  async tick(db: PoolClient): Promise<TradingResult | null> {
    const hasKey = !!(process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID)
    if (!hasKey) return null

    try {
      const monitor = await this.monitorPositions(db)
      if (monitor) return monitor

      const open = await Alpaca.isMarketOpen().catch(() => false)
      if (!open) return null

      return await this.executePick(db)
    } catch {
      return null
    }
  }

  private async monitorPositions(db: PoolClient): Promise<TradingResult | null> {
    const positions = await Alpaca.getPositions().catch(() => [] as Alpaca.AlpacaPosition[])

    for (const pos of positions) {
      const { rows } = await db.query(
        `SELECT * FROM lila_positions WHERE symbol=$1 AND status='open' LIMIT 1`,
        [pos.symbol]
      )
      const tracked = rows[0]
      if (!tracked) continue

      const current = parseFloat(pos.current_price)
      const entry = parseFloat(tracked.entry_price ?? pos.avg_entry_price)
      const pnlPct = parseFloat(pos.unrealized_plpc) * 100
      const pnl = parseFloat(pos.unrealized_pl)

      const target = tracked.target_price ? parseFloat(tracked.target_price) : null
      const hitTarget = target !== null && current >= target

      // Tight stop: honor per-pick stop_loss if set, otherwise DEFAULT_STOP_PCT.
      const stopPrice = tracked.stop_loss ? parseFloat(tracked.stop_loss) : null
      const hitStop = stopPrice !== null
        ? current <= stopPrice
        : pnlPct <= -DEFAULT_STOP_PCT

      if (hitTarget || hitStop) {
        await Alpaca.closePosition(pos.symbol).catch(() => {})
        await db.query(
          `UPDATE lila_positions SET status='closed', pnl=$1, closed_at=NOW() WHERE id=$2`,
          [pnl, tracked.id]
        )
        if (hitTarget && pnl > 0) {
          await db.query('UPDATE lila_state SET total_earned=total_earned+$1 WHERE id=1', [pnl])
        }
        const tag = hitTarget ? 'Target hit' : 'Stop hit'
        const sign = pnl >= 0 ? '+' : ''
        return {
          action: 'sold', symbol: pos.symbol, pnl,
          logMessage: `${tag}: closed ${pos.symbol} at $${current.toFixed(2)} (from $${entry.toFixed(2)}). ${sign}$${pnl.toFixed(2)} P&L.`,
          logType: hitTarget ? 'success' : 'warn',
        }
      }
    }
    return null
  }

  private async executePick(db: PoolClient): Promise<TradingResult> {
    const { rows: picks } = await db.query(
      `SELECT * FROM analyst_picks
       WHERE status='pending' AND created_at > NOW() - INTERVAL '6 hours'
       ORDER BY confidence DESC LIMIT 1`
    )
    if (!picks.length) {
      return { action: 'idle', logMessage: 'Vega queue empty. Awaiting next analysis.', logType: 'info' }
    }

    const pick = picks[0]

    const { rows: existing } = await db.query(
      `SELECT id FROM lila_positions WHERE symbol=$1 AND status='open' LIMIT 1`,
      [pick.symbol]
    )
    if (existing.length) {
      await db.query(`UPDATE analyst_picks SET status='dismissed' WHERE id=$1`, [pick.id])
      return { action: 'idle', logMessage: `Already holding ${pick.symbol}. Pick dismissed.`, logType: 'info' }
    }

    const account = await Alpaca.getAccount()
    const buyingPower = parseFloat(account.buying_power)
    const notional = Math.min(buyingPower * MAX_POSITION_PCT, buyingPower)

    if (notional < MIN_NOTIONAL) {
      return { action: 'idle', logMessage: `Insufficient buying power ($${buyingPower.toFixed(2)}). Holding.`, logType: 'warn' }
    }

    try {
      await Alpaca.placeOrder({ symbol: pick.symbol, notional, side: 'buy', type: 'market', time_in_force: 'day' })
      await db.query(
        `INSERT INTO lila_positions (symbol, direction, entry_price, target_price, stop_loss, pick_id)
         VALUES ($1,'long',$2,$3,$4,$5)`,
        [pick.symbol, pick.entry_price, pick.target_price, pick.stop_loss, pick.id]
      )
      await db.query(`UPDATE analyst_picks SET status='executed' WHERE id=$1`, [pick.id])

      const stop = pick.stop_loss ? `$${parseFloat(pick.stop_loss).toFixed(2)}` : `-${DEFAULT_STOP_PCT}%`
      return {
        action: 'bought', symbol: pick.symbol, notional,
        logMessage: `Bought ${pick.symbol} — $${notional.toFixed(2)} @ ~$${parseFloat(pick.entry_price).toFixed(2)}. Target $${parseFloat(pick.target_price).toFixed(2)} · stop ${stop}. ${pick.reason}`,
        logType: 'success',
      }
    } catch (e) {
      return { action: 'error', logMessage: `Order failed for ${pick.symbol}: ${String(e)}`, logType: 'warn' }
    }
  }
}
