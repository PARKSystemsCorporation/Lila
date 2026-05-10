// Local verification harness for the memory layer.
//
// Run with: DATABASE_URL=... npx tsx scripts/seed-memory.ts
//
// 1. ensureSchema applies the new memory_* tables.
// 2. Seeds 1 entity, 5 episodes, and ingests 100 chat-like lines via processMsg.
// 3. Calls recall() on a sample query and pretty-prints each channel.
// 4. Calls renderRecall() and prints the prompt-injection block.
// 5. Cleans up nothing — leaves data in place so you can poke around.

import { getPool, ensureSchema } from '../lib/db'
import { upsertEntity, writeEpisode } from '../lib/memory/store'
import { processMsg, runDecay } from '../lib/memory/correlations'
import { recall, renderRecall } from '../lib/memory/retrieve'

const SAMPLE_LINES = [
  'cipher mapped the ProtocolX vault deposit flow today',
  'router dispatched a help-request task through the desk',
  'vega filed a GLD pick at 178.10 with stop 175',
  'cipher confirmed the ProtocolX invariant holds under reentrancy',
  'router cached the last route path in management state',
  'lila replied to the operator about pending payouts',
  'vega briefed lila on commodity exposure across the macro basket',
  'cipher opened a hypothesis about ProtocolX oracle staleness',
  'router gated the autonomy step until weekday hours',
  'lila approved the desk item from cipher about the finding',
  'desk filed a code-request for the autonomy tool layer',
  'cipher inspected the surfaces of ProtocolX router contract',
  'vega closed the SLV position at small profit and rotated',
  'lila summarized the day with three picks and one closed bounty',
  'router notes the next primary slot for the cipher loop',
  'cipher dispatched investigate on the open hypothesis queue',
  'vega flagged unusual volume on the macro EFA basket today',
  'lila pushed a desk briefing on weekly bounty earnings',
  'router consults the recent chat block before picking a leaf',
  'cipher reviewed the architecture notes for ProtocolX again',
]

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL required'); process.exit(1)
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    console.log('[schema] memory_* tables ensured')

    // 1. Entity ----------------------------------------------------------
    const eid = await upsertEntity(db, {
      kind: 'bounty', slug: 'protocolx', display_name: 'ProtocolX', aliases: ['px'],
    })
    console.log(`[seed] entity #${eid} (protocolx) upserted`)

    // 2. Episodes --------------------------------------------------------
    const epIds: number[] = []
    for (const line of SAMPLE_LINES.slice(0, 5)) {
      const id = await writeEpisode(db, {
        source: 'research_note', actor: 'cipher', entity_id: eid, content: line,
      })
      epIds.push(id)
    }
    console.log(`[seed] ${epIds.length} episodes written`)

    // 3. Correlation ingestion ------------------------------------------
    // Cycle through the lines 5x to give pairs a real reinforcement signal.
    let ingested = 0
    for (let pass = 0; pass < 5; pass++) {
      for (const line of SAMPLE_LINES) {
        await processMsg(db, line)
        ingested++
      }
    }
    console.log(`[seed] ${ingested} processMsg calls`)

    // 4. Recall ----------------------------------------------------------
    const hits = await recall(db, {
      text: 'router dispatch tool for cipher',
      scope: { entity_slug: 'protocolx', entity_kind: 'bounty' },
    })
    console.log(`[recall] channels`, hits.channels)
    console.log(`[recall] context_line: ${hits.context_line.slice(0, 240)}`)
    console.log(`[recall] correlations: ${hits.correlations.length} (top 3):`)
    for (const c of hits.correlations.slice(0, 3)) {
      console.log(`  - [${c.tier}] ${c.w1} ↔ ${c.w2}  (score=${c.score.toFixed(2)} reinf=${c.reinf})`)
    }
    console.log(`[recall] episodes: ${hits.episodes.length} (top 3):`)
    for (const e of hits.episodes.slice(0, 3)) {
      console.log(`  - ${e.occurred_at}  ${e.actor ?? e.source}: ${e.content.slice(0, 80)}`)
    }

    // 5. Render block ---------------------------------------------------
    const block = renderRecall(hits, 800)
    console.log('\n[render] prompt-injection block:\n' + block)

    // 6. Decay sweep — fast-forward the counter past the lease and run.
    const before = await db.query(`SELECT COUNT(*) AS n FROM memory_short`)
    await db.query(`UPDATE memory_state SET counter = counter + 200 WHERE id = 1`)
    const swept = await runDecay(db)
    const after = await db.query(`SELECT COUNT(*) AS n FROM memory_short`)
    console.log(`\n[decay] short-tier rows ${before.rows[0].n} → ${after.rows[0].n} (sweep: ${JSON.stringify(swept)})`)
  } finally {
    db.release()
    await pool.end()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
