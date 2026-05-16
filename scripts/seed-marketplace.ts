// Operator catalog seeder for the marketplace.
//
// Run with: DATABASE_URL=... npx tsx scripts/seed-marketplace.ts
//
// 1. ensureSchema applies the marketplace_* tables.
// 2. Upserts every entry in ITEMS by slug (edit this list to curate).
// 3. artifact_path is resolved at download time inside MARKETPLACE_DIR
//    (default <cwd>/private/marketplace) — drop the actual files there.
//
// Idempotent: re-running updates title/blurb/cost/path and (re)activates
// the row without creating duplicates or touching purchases.

import { getPool, ensureSchema } from '../lib/db'

interface SeedItem {
  slug: string
  title: string
  blurb: string
  gate_cost: number
  artifact_path: string   // relative to MARKETPLACE_DIR
}

// ── Curate here ────────────────────────────────────────────────────────
const ITEMS: SeedItem[] = [
  {
    slug: 'autonomy-tree-blueprint',
    title: 'Autonomy Tree Blueprint',
    blurb: 'The full server-side ticker + phase-machine design, annotated. Wiring, gates, and the cost-discipline layer.',
    gate_cost: 30,
    artifact_path: 'autonomy-tree-blueprint.zip',
  },
  {
    slug: 'bazaar-escrow-schematic',
    title: 'Bazaar Escrow Schematic',
    blurb: 'Milestone-gated SPL escrow: PDA layout, signer rules, and the moderator/co-sign release model.',
    gate_cost: 45,
    artifact_path: 'bazaar-escrow-schematic.zip',
  },
]
// ───────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL required'); process.exit(1)
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    console.log('[schema] marketplace_* tables ensured')

    for (const it of ITEMS) {
      await db.query(
        `INSERT INTO marketplace_items (slug, title, blurb, gate_cost, artifact_path, active)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         ON CONFLICT (slug) DO UPDATE
           SET title         = EXCLUDED.title,
               blurb         = EXCLUDED.blurb,
               gate_cost     = EXCLUDED.gate_cost,
               artifact_path = EXCLUDED.artifact_path,
               active        = TRUE`,
        [it.slug, it.title, it.blurb, it.gate_cost, it.artifact_path],
      )
      console.log(`[seed] item upserted: ${it.slug} (${it.gate_cost} pg)`)
    }

    const n = await db.query(`SELECT COUNT(*)::int AS c FROM marketplace_items WHERE active = TRUE`)
    console.log(`[done] ${n.rows[0].c} active item(s) in the catalog`)
  } finally {
    db.release()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
