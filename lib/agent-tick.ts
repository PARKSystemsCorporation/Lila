import type { PoolClient } from 'pg'
import { getPool, ensureSchema } from './db'
import { TradingEngine } from './trading-engine'
import { AnalystLoop } from './analyst-loop'
import { TaskerLoop } from './tasker-loop'
import { ScoutLoop } from './scout-loop'
import { ManagementLoop } from './management-loop'
import { BroadcastLoop } from './broadcast-loop'
import { DiscoveryLoop } from './discovery-loop'
import { CeeloLoop } from './ceelo-loop'
import { mirrorLilaToTelegram } from './telegram-mirror'
import { runNoonArticles } from './article-engine'
import { runAlerts } from './alerts'
import { runRetention } from './retention'
import { runSubmitter } from './github-pr'
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

    // 3b. Scout — volume bounty hunter. Shallow scans, files drafts to the
    //     same security_reports queue Lila reviews for Cipher.
    const scout = new ScoutLoop(db)
    const scoutResult = await scout.run().catch((e: unknown) => ({
      logMessage: `Scout error: ${String(e)}`,
      logType: 'warn' as const,
    }))
    if (scoutResult) {
      await logEvent(db, scoutResult.logMessage, scoutResult.logType)
      logs.push(scoutResult.logMessage)
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

    // 4b. Telegram bridge — mirror Lila's replies back to Telegram when
    //     the active conversation came from there. Runs immediately after
    //     management so any reply just generated this tick goes out now.
    const mirrorResult = await mirrorLilaToTelegram(db).catch((e: unknown) => ({
      sent: 0, failed: 0,
      logMessage: `Telegram mirror error: ${String(e)}`,
      logType: 'warn' as const,
    }))
    if (mirrorResult?.logMessage) {
      await logEvent(db, mirrorResult.logMessage, mirrorResult.logType ?? 'info')
      logs.push(mirrorResult.logMessage)
    }

    // 5. Ceelo — NFL handicapper, time-gated (12h default).
    const ceelo = new CeeloLoop(db)
    const ceeloResult = await ceelo.run().catch((e: unknown) => ({
      logMessage: `Ceelo error: ${String(e)}`,
      logType: 'warn' as const,
    }))
    if (ceeloResult) {
      await logEvent(db, ceeloResult.logMessage, ceeloResult.logType)
      logs.push(ceeloResult.logMessage)
    }

    // 6. Discovery — daily scan for new protocols / Solidity repos.
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

    // 6b. Noon Substack reports — Lila / Vega / Ceelo each write once per
    //     UTC day at/after noon. Article-engine handles the gate per author.
    const articleResult = await runNoonArticles(db).catch((e: unknown) => ({
      generated: [] as ('lila'|'vega'|'ceelo')[],
      skipped:   [] as ('lila'|'vega'|'ceelo')[],
      _error:    String(e).slice(0, 120),
    }))
    if (articleResult.generated.length > 0) {
      const msg = `Noon articles filed: ${articleResult.generated.join(', ')}.`
      await logEvent(db, msg, 'success')
      logs.push(msg)
    }

    // 6b2. GitHub PR submitter — opens one PR per tick from approved
    //      bounty_picks rows. No-op unless GITHUB_TOKEN + LILA_AUTO_SUBMIT
    //      are both set (kill-switch lives in env, not in code).
    const submitResult = await runSubmitter(db).catch((e: unknown) => ({
      ran: true, submitted: 0, failed: 1,
      logMessage: `Submitter error: ${String(e).slice(0, 120)}`,
      logType: 'warn' as const,
    }))
    if (submitResult?.logMessage) {
      await logEvent(db, submitResult.logMessage, submitResult.logType ?? 'info')
      logs.push(submitResult.logMessage)
    }

    // 6c. Telegram alerts — paid bounties, ready-to-submit Scout drafts,
    //     high-confidence Ceelo edges, meaningful trade closes. Per-row
    //     dedup via tg_alerted_at. Silent if Telegram isn't configured.
    const alertResult = await runAlerts(db).catch((e: unknown) => ({
      sent: 0, failed: 0, classes: {},
      logMessage: `Alert error: ${String(e).slice(0, 80)}`,
      logType: 'warn' as const,
    }))
    if (alertResult?.logMessage) {
      await logEvent(db, alertResult.logMessage, alertResult.logType ?? 'info')
      logs.push(alertResult.logMessage)
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
