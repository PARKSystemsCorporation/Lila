import type { PoolClient } from 'pg'
import * as DefiLlama from './sources/defillama'
import * as GitHub from './sources/github'

// ── Protocol discovery loop ──────────────────────────────────────────────────
// Daily scan of DefiLlama + GitHub for young, under-audited protocols and new
// Solidity repos. Results land in watch_targets with status='watching' for
// the operator (or Lila) to promote into research_targets.
//
// Free / key-optional:
//   - DefiLlama: no auth, no quota to worry about at 1 pull/day
//   - GitHub: 60 req/hr unauthenticated, 5k with GITHUB_TOKEN

const DAY_MS = 24 * 60 * 60 * 1000

type LogType = 'info' | 'success' | 'warn'

export interface DiscoveryResult {
  inserted: number
  skipped: number
  sources: string[]
  logMessage: string
  logType: LogType
}

export class DiscoveryLoop {
  constructor(private db: PoolClient) {}

  async shouldRun(): Promise<boolean> {
    const { rows: [s] } = await this.db.query(
      'SELECT last_run_at FROM discovery_state WHERE id=1'
    )
    if (!s?.last_run_at) return true
    return Date.now() - new Date(s.last_run_at).getTime() >= DAY_MS
  }

  async run(force = false): Promise<DiscoveryResult | null> {
    if (!force && !(await this.shouldRun())) return null

    let inserted = 0
    let skipped = 0
    const sources: string[] = []

    // ── DefiLlama ──────────────────────────────────────────────────────────
    try {
      const items = await DefiLlama.discoverNew()
      if (items.length > 0) sources.push(`defillama:${items.length}`)
      for (const it of items) {
        const res = await this.upsert({
          source: 'defillama',
          externalId: it.externalId,
          name: it.name,
          url: it.url ?? null,
          chain: it.chain ?? null,
          tvl: it.tvl ?? null,
          stars: null,
          listedAt: it.listedAt ?? null,
          scope: it.scope ?? '',
        })
        if (res === 'inserted') inserted++
        else skipped++
      }
    } catch { /* source-level failures don't stop the pass */ }

    // ── GitHub ─────────────────────────────────────────────────────────────
    try {
      const items = await GitHub.discoverNew()
      if (items.length > 0) sources.push(`github:${items.length}`)
      for (const it of items) {
        const res = await this.upsert({
          source: 'github',
          externalId: it.externalId,
          name: it.name,
          url: it.url,
          chain: null,
          tvl: null,
          stars: it.stars,
          listedAt: it.listedAt,
          scope: it.scope,
        })
        if (res === 'inserted') inserted++
        else skipped++
      }
    } catch { /* ignore */ }

    await this.db.query(
      'UPDATE discovery_state SET last_run_at=NOW(), updated_at=NOW() WHERE id=1'
    )

    const logMessage = inserted > 0
      ? `Discovery: +${inserted} new watch target${inserted === 1 ? '' : 's'} (${sources.join(', ') || 'no sources'}).`
      : `Discovery: 0 new, ${skipped} already tracked.`

    return {
      inserted,
      skipped,
      sources,
      logMessage,
      logType: inserted > 0 ? 'success' : 'info',
    }
  }

  private async upsert(row: {
    source: string
    externalId: string
    name: string
    url: string | null
    chain: string | null
    tvl: number | null
    stars: number | null
    listedAt: Date | null
    scope: string
  }): Promise<'inserted' | 'skipped'> {
    const { rows } = await this.db.query(
      `INSERT INTO watch_targets (source, external_id, name, url, chain, tvl, stars, listed_at, scope)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (source, external_id) DO UPDATE
         SET tvl        = EXCLUDED.tvl,
             stars      = EXCLUDED.stars,
             scope      = EXCLUDED.scope,
             updated_at = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [row.source, row.externalId, row.name, row.url, row.chain, row.tvl, row.stars, row.listedAt, row.scope]
    )
    return rows[0]?.inserted ? 'inserted' : 'skipped'
  }
}
