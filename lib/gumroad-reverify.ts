// Gumroad subscription poller. Fired once per autonomy tick, this picks
// the oldest-verified active viewer and re-runs Gumroad's license verify
// against them. If the response shows refunded / cancelled / failed /
// ended, viewer.active flips FALSE and we log it. The Park Gates balance
// + ledger are preserved so a re-subscribe restores the wallet exactly.
//
// Why polling instead of a webhook? Gumroad's "Resource Subscriptions"
// feature is no longer in the UI; it's API-only and requires an OAuth
// access token. Polling is uglier on paper but objectively more robust:
// no shared secret, no URL config, no missed events, idempotent retries.
//
// Cycle math: 30s ticks × 1 viewer per tick = 2,880 viewers/day. A real
// subscriber list won't approach that for a long time, so every active
// viewer gets re-verified at least once an hour even at modest scale.
//
// Cost gate: pause if the LATEST tick already verified one and < REVERIFY_GAP_SEC
// has passed (defensive — the autonomy ticker shouldn't double-fire,
// but if /api/agent gets pounded by the UI we don't want to burn the
// Gumroad rate limit).

import type { PoolClient } from 'pg'
import * as Gumroad from './gumroad'

const REVERIFY_GAP_SEC = 20

export interface ReverifyResult {
  ran: boolean
  viewerId: number | null
  flipped: 'deactivated' | 'no_change' | 'error' | null
  reason: string | null
  logMessage: string
  logType: 'info' | 'success' | 'warn'
}

let lastRunMs = 0

export async function runGumroadReverify(db: PoolClient): Promise<ReverifyResult | null> {
  if (!Gumroad.isConfigured()) return null
  const now = Date.now()
  if (now - lastRunMs < REVERIFY_GAP_SEC * 1000) return null

  // Pick the active viewer with the oldest verified_at. Ties broken by id
  // so the cycle is deterministic. We touch verified_at on every check
  // so the next tick advances to the next-oldest.
  const { rows } = await db.query<{
    id: number
    license_key: string
    gumroad_subscription_id: string | null
    active: boolean
  }>(
    `SELECT id, license_key, gumroad_subscription_id, active
       FROM viewers
      WHERE active = TRUE
      ORDER BY verified_at ASC, id ASC
      LIMIT 1`,
  )
  const v = rows[0]
  if (!v) return null

  lastRunMs = now

  const productId = process.env.GUMROAD_PRODUCT_ID!
  const result = await Gumroad.verifyLicense(productId, v.license_key, { incrementUses: false })

  // Network/API outage: don't flip anything, just log and try the same row
  // again next cycle.
  if (!result.ok) {
    return {
      ran: true,
      viewerId: v.id,
      flipped: 'error',
      reason: result.error ?? 'unknown',
      logMessage: `Gumroad reverify ${v.id}: error ${(result.error ?? '').slice(0, 80)}`,
      logType: 'warn',
    }
  }

  // Touch verified_at + bump subscription_id if it just appeared.
  await db.query(
    `UPDATE viewers
        SET verified_at = NOW(),
            gumroad_subscription_id = COALESCE($2, gumroad_subscription_id)
      WHERE id = $1`,
    [v.id, result.subscriptionId],
  )

  if (!result.active) {
    const reason =
        result.refunded  ? 'refunded'
      : result.cancelled ? 'cancelled'
      : result.failed    ? 'failed'
      : result.ended     ? 'ended'
      : 'inactive'
    await db.query(`UPDATE viewers SET active = FALSE WHERE id = $1`, [v.id])
    return {
      ran: true,
      viewerId: v.id,
      flipped: 'deactivated',
      reason,
      logMessage: `Viewer ${v.id} deactivated (${reason}).`,
      logType: 'success',
    }
  }

  return {
    ran: true,
    viewerId: v.id,
    flipped: 'no_change',
    reason: null,
    logMessage: `Gumroad reverify ${v.id}: still active.`,
    logType: 'info',
  }
}
