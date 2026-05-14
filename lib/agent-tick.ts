import type { PoolClient } from 'pg'
import { getPool, ensureSchema } from './db'
import { TradingEngine } from './trading-engine'
import { AnalystLoop } from './analyst-loop'
import { TaskerLoop } from './tasker-loop'
import { ScoutLoop } from './scout-loop'
import { ForgeLoop } from './forge-loop'
import { ArtistLoop } from './artist-loop'
import { AutonomyLoop } from './autonomy/loop'
import { BroadcastLoop } from './broadcast-loop'
import { DiscoveryLoop } from './discovery-loop'
import { CeeloLoop } from './ceelo-loop'
import { SportsLoop } from './sports/sports-loop'
import { HorseLoop } from './horse-racing/horse-loop'
import { DmLoop } from './dm-loop'
import { runGumroadReverify } from './gumroad-reverify'
import { runNoonArticles } from './article-engine'
import { runRetention } from './retention'
import { runSubmitter } from './github-pr'
import { runDevtoPublisher } from './devto-publish'
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

    // Big-red-button check. When the operator has paused autonomy from
    // the header, every subloop short-circuits — no trading, no Vega,
    // no Cipher, no Ceelo, no Lila. The ticker keeps polling but each
    // pass is a no-op until the flag clears via /api/autonomy resume.
    const { rows: [pauseRow] } = await db.query(
      `SELECT autonomy_paused FROM lila_state WHERE id=1`
    )
    if (pauseRow?.autonomy_paused) {
      return { ran: false, logs: ['autonomy paused by operator'] }
    }

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

    // 3a. Forge — fast Algora-only PR drafter ($50-$200, Bug/Feature).
    //     Files into bounty_picks; runSubmitter ships approved rows.
    const forge = new ForgeLoop(db)
    const forgeResult = await forge.run().catch((e: unknown) => ({
      logMessage: `Forge error: ${String(e)}`,
      logType: 'warn' as const,
    }))
    if (forgeResult) {
      await logEvent(db, forgeResult.logMessage, forgeResult.logType)
      logs.push(forgeResult.logMessage)
    }

    // 3a2. Artist — paints one image per cycle via fal.ai FLUX.1 schnell.
    //      No-ops cleanly when FAL_API_KEY isn't set.
    const artist = new ArtistLoop(db)
    const artistResult = await artist.run().catch((e: unknown) => ({
      logMessage: `Artist error: ${String(e)}`,
      logType: 'warn' as const,
    }))
    if (artistResult) {
      await logEvent(db, artistResult.logMessage, artistResult.logType)
      logs.push(artistResult.logMessage)
    }

    // 3b. Scout — gig hunter (RemoteOK → WWR fallback) + tutorial
    //     fallback when both gig sources are dry. Tutorials file into
    //     `articles` with kind='tutorial'; runDevtoPublisher posts the
    //     approved ones to dev.to.
    const scout = new ScoutLoop(db)
    const scoutResult = await scout.run().catch((e: unknown) => ({
      logMessage: `Scout error: ${String(e)}`,
      logType: 'warn' as const,
    }))
    if (scoutResult) {
      await logEvent(db, scoutResult.logMessage, scoutResult.logType)
      logs.push(scoutResult.logMessage)
    }

    // 4. Lila — hierarchical decision tree in lib/autonomy/. Routes to
    //    a leaf each tick, queues a 10-step plan, then advances one step
    //    per tick until the plan drains.
    const mgmt = new AutonomyLoop(db)
    const mgmtResult = await mgmt.run().catch((e: unknown) => ({
      logMessage: `Autonomy error: ${String(e)}`,
      logType: 'warn' as const,
      posted: false,
    }))
    if (mgmtResult) {
      await logEvent(db, mgmtResult.logMessage, mgmtResult.logType)
      logs.push(mgmtResult.logMessage)
    }

    // 4b. Gumroad subscription poller — re-verifies one active viewer per
    //      tick (oldest verified_at first). Catches cancellations / refunds /
    //      failed renewals without depending on Gumroad webhooks. Skips when
    //      Gumroad isn't configured.
    const reverifyResult = await runGumroadReverify(db).catch((e: unknown) => ({
      ran: true,
      viewerId: null,
      flipped: 'error' as const,
      reason: String(e).slice(0, 80),
      logMessage: `Gumroad reverify error: ${String(e).slice(0, 120)}`,
      logType: 'warn' as const,
    }))
    if (reverifyResult?.flipped === 'deactivated' || reverifyResult?.flipped === 'error') {
      await logEvent(db, reverifyResult.logMessage, reverifyResult.logType)
      logs.push(reverifyResult.logMessage)
    }

    // 4c. Marketplace DMs — answer one queued viewer DM per tick. Per-agent
    //     persona, grounded in real recent desk activity, budget-respecting.
    const dms = new DmLoop(db)
    const dmResult = await dms.run().catch((e: unknown) => ({
      logMessage: `DM loop error: ${String(e).slice(0, 120)}`,
      logType: 'warn' as const,
    }))
    if (dmResult) {
      await logEvent(db, dmResult.logMessage, dmResult.logType)
      logs.push(dmResult.logMessage)
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

    // 5a. Sports ingestion — API-Sports + ParlayAPI + ProphetX → 1-10
    //     scores per NBA game side, feeding the /theyield/sports/nba
    //     portal. Self-gates on ENABLE_SPORTS_LOOP=true.
    const sports = new SportsLoop(db)
    const sportsResult = await sports.run().catch((e: unknown) => ({
      logMessage: `Sports error: ${String(e)}`,
      logType: 'warn' as const,
    }))
    if (sportsResult) {
      await logEvent(db, sportsResult.logMessage, sportsResult.logType)
      logs.push(sportsResult.logMessage)
    }

    // 5b. Horse — thoroughbred racecards via The Racing API. Self-gates
    //     on ENABLE_HORSE_RACING + missing creds; 1 RPS upstream limit
    //     is enforced inside lib/horse-racing/rate-limiter.ts so the
    //     loop can run as often as HORSE_RUN_SEC permits.
    const horse = new HorseLoop(db)
    const horseResult = await horse.run().catch((e: unknown) => ({
      logMessage: `Horse error: ${String(e)}`,
      logType: 'warn' as const,
    }))
    if (horseResult) {
      await logEvent(db, horseResult.logMessage, horseResult.logType)
      logs.push(horseResult.logMessage)
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

    // 6b3. dev.to publisher — posts one approved Scout tutorial per tick.
    //      No-op unless DEVTO_API_KEY is set.
    const devtoResult = await runDevtoPublisher(db).catch((e: unknown) => ({
      ran: true, published: 0, failed: 1,
      logMessage: `dev.to publish error: ${String(e).slice(0, 120)}`,
      logType: 'warn' as const,
    }))
    if (devtoResult?.logMessage) {
      await logEvent(db, devtoResult.logMessage, devtoResult.logType ?? 'info')
      logs.push(devtoResult.logMessage)
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
