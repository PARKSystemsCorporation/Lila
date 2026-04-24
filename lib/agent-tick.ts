import type { PoolClient } from 'pg'
import { getPool, ensureSchema } from './db'
import { TradingEngine } from './trading-engine'
import { AnalystLoop } from './analyst-loop'
import { TaskerLoop } from './tasker-loop'
import { ManagementLoop } from './management-loop'
import { BroadcastLoop } from './broadcast-loop'
import { DiscoveryLoop } from './discovery-loop'
import { runRetention } from './retention'
import { cfg } from './config'

// Single entry point for an autonomy tick. Called from /api/agent (UI poll)
// and from the server-side ticker. DB schema is lazy-init, a no-op after
// the first call.

export interface TickOutcome {
  ran: boolean
  logs: string[]
}

let inflight: Promise<TickOutcome> | null = null

export function runAgentTick(): Promise<TickOutcome> {
  // De-dupe overlapping callers (UI poll + server ticker racing each other).
  if (inflight) return inflight
  inflight = runAgentTickInner().finally(() => { inflight = null })
  return inflight
}

// ── Server-side autonomy ticker ───────────────────────────────────────────────
// Arms on first import of this module (which only happens inside a Node.js
// route — never in Edge). Lila keeps running even when no client has the PWA
// open. Opt out: ENABLE_AUTONOMY_TICKER=false.

let tickerStarted = false
function startTicker() {
  if (tickerStarted) return
  if (!cfg.ENABLE_AUTONOMY_TICKER) return
  if (process.env.NEXT_PHASE === 'phase-production-build') return
  tickerStarted = true

  const interval = cfg.AUTONOMY_TICK_MS
  setTimeout(() => {
    setInterval(() => {
      runAgentTick().catch(e => console.error('[autonomy] tick failed:', e))
    }, interval)
  }, 5_000)
  console.log(`[autonomy] ticker armed (every ${interval}ms)`)
}

startTicker()

async function runAgentTickInner(): Promise<TickOutcome> {
  if (!process.env.DATABASE_URL) return { ran: false, logs: ['No DATABASE_URL set — demo mode.'] }

  const pool = getPool()
  const db = await pool.connect()
  const logs: string[] = []

  try {
    await ensureSchema(db)
    await db.query('UPDATE lila_state SET tick_count = tick_count + 1, updated_at = NOW() WHERE id = 1')

    // 1. Position monitoring runs every tick (honors tight stops).
    const trader = new TradingEngine()
    const tradeResult = await trader.tick(db).catch(() => null)
    if (tradeResult && (tradeResult.action === 'bought' || tradeResult.action === 'sold')) {
      await logEvent(db, tradeResult.logMessage, tradeResult.logType)
      logs.push(tradeResult.logMessage)
    }

    // 2. Vega loop — time-gated internally.
    const analyst = new AnalystLoop(db)
    const analystResult = await analyst.run().catch(() => null)
    if (analystResult) {
      await logEvent(db, analystResult.logMessage, analystResult.logType)
      logs.push(analystResult.logMessage)
    }

    // 3. Cipher loop — time-gated internally.
    const tasker = new TaskerLoop(db)
    const taskerResult = await tasker.run().catch((e: unknown) => ({
      step: 'BT0' as const,
      logMessage: `Cipher loop error: ${String(e)}`,
      logType: 'warn' as const,
    }))
    if (taskerResult) {
      await logEvent(db, taskerResult.logMessage, taskerResult.logType)
      logs.push(taskerResult.logMessage)
    }

    // 4. Management Lila — replies to operator, proactive check-ins.
    const mgmt = new ManagementLoop(db)
    const mgmtResult = await mgmt.run().catch((e: unknown) => ({
      logMessage: `Management error: ${String(e)}`,
      logType: 'warn' as const,
      posted: false,
    }))
    if (mgmtResult) {
      await logEvent(db, mgmtResult.logMessage, mgmtResult.logType)
      logs.push(mgmtResult.logMessage)
    }

    // 5. Discovery — daily scan for new protocols / Solidity repos.
    const discovery = new DiscoveryLoop(db)
    const discoveryResult = await discovery.run().catch((e: unknown) => ({
      inserted: 0, skipped: 0, sources: [] as string[],
      logMessage: `Discovery error: ${String(e)}`,
      logType: 'warn' as const,
    }))
    if (discoveryResult) {
      await logEvent(db, discoveryResult.logMessage, discoveryResult.logType)
      logs.push(discoveryResult.logMessage)
    }

    // 6. Broadcast loop — hourly public post, skips silent hours.
    const broadcast = new BroadcastLoop(db)
    const broadcastResult = await broadcast.run().catch((e: unknown) => ({
      logMessage: `Broadcast error: ${String(e)}`,
      logType: 'warn' as const,
      posted: false,
    }))
    if (broadcastResult) {
      await logEvent(db, broadcastResult.logMessage, broadcastResult.logType)
      logs.push(broadcastResult.logMessage)
    }

    // 7. Retention — once per 24h, trims stale log/usage/chat/broadcast rows.
    const retentionResult = await runRetention(db).catch((e: unknown) => ({
      ran: true,
      deleted: {},
      logMessage: `Retention error: ${String(e)}`,
      logType: 'warn' as const,
    }))
    if (retentionResult) {
      await logEvent(db, retentionResult.logMessage, retentionResult.logType)
      logs.push(retentionResult.logMessage)
    }

    return { ran: true, logs }
  } finally {
    db.release()
  }
}

async function logEvent(db: PoolClient, message: string, type: string): Promise<void> {
  await db.query('INSERT INTO lila_log (message, type) VALUES ($1,$2)', [message, type])
}
