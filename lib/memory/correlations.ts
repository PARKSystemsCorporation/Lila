import type { PoolClient } from 'pg'
import { randomUUID } from 'crypto'
import { tokenize, pairKey, STOPS } from './tokens'

// Three-tier word-pair correlation memory, ported from
// PARKSystemsCorporation/2dkira server.js. Same scoring formula, same tier
// thresholds, same pair-window (5), same DELETE+INSERT promotion, same
// new/reinforced decay leases (+100/+200). Decay-sweep itself is a Lila
// addition since 2dkira leaves decay_at unused (see runDecay below).

export type Tier = 'short' | 'medium' | 'long'
const TIERS: Tier[] = ['long', 'medium', 'short']  // search order: prefer durable
const TABLE: Record<Tier, string> = {
  short:  'memory_short',
  medium: 'memory_medium',
  long:   'memory_long',
}

export interface Correlation {
  id: string
  pk: string
  w1: string
  w2: string
  p1: string
  p2: string
  rel: string
  sent: string
  score: number
  reinf: number
  decay_at: number
  last_msg: number
  created: number
  updated: number
  tier: Tier
}

// ── Scoring (verbatim port of 2dkira `score()`) ──────────────────────────────
function scoreOf(spos1: string, spos2: string, dist: number): number {
  const cat =
    (spos1 === 'noun' && spos2 === 'noun') ? 0.3 :
    (spos1 === 'adj'  || spos2 === 'adj')  ? 0.2 :
    0.1
  const prox =
    dist === 0 ? 0.4 :
    dist === 1 ? 0.3 :
    dist <= 3  ? 0.2 :
    0.1
  const base = 0.15
  return Math.min(base + cat + prox, 1.0)
}

// ── Tier function (verbatim port) ────────────────────────────────────────────
export function tierOf(score: number): Tier {
  if (score >= 0.65) return 'long'
  if (score >= 0.25) return 'medium'
  return 'short'
}

// ── Counter (KIRA's nextIdx, folded into memory_state singleton) ─────────────
export async function nextIdx(db: PoolClient): Promise<number> {
  const { rows } = await db.query(
    `UPDATE memory_state SET counter = counter + 1, updated_at = NOW() WHERE id = 1 RETURNING counter`
  )
  return Number(rows[0]?.counter ?? 1)
}

function rowToCorrelation(r: Record<string, unknown>, tier: Tier): Correlation {
  return {
    id: String(r.id),
    pk: String(r.pk),
    w1: String(r.w1),
    w2: String(r.w2),
    p1: String(r.p1 ?? ''),
    p2: String(r.p2 ?? ''),
    rel: String(r.rel ?? ''),
    sent: String(r.sent ?? ''),
    score: Number(r.score),
    reinf: Number(r.reinf),
    decay_at: Number(r.decay_at ?? 0),
    last_msg: Number(r.last_msg ?? 0),
    created: Number(r.created ?? 0),
    updated: Number(r.updated ?? 0),
    tier,
  }
}

// ── Ingestion ────────────────────────────────────────────────────────────────
// Port of 2dkira `processMsg`, batched. Semantics match the original line-by-
// line: same window of 5, same scoreOf/tierOf, same +sc reinforcement on
// existing pairs, same +1 reinf bump per occurrence, same new-pair lease
// (idx + 100), same reinforced lease (idx + 200), same DELETE-old + INSERT-new
// on tier change, same pair-key sort, same `if source !== 'user' return` gate.
//
// What changed: instead of `findExisting` (3 SELECTs) + INSERT/UPDATE per pair
// — i.e. up to 4 round trips × dozens of pairs per message — we now do one
// UNION-ALL lookup over all pair keys at once, then one batched write per
// (op, tier) bucket. Realistic ingest cost drops from ~320 queries to ~6-10.
export async function processMsg(
  db: PoolClient,
  text: string,
  source: 'user' | 'system' = 'user',
): Promise<void> {
  if (source !== 'user') return
  const tokens = tokenize(text)
  if (tokens.length < 2) return

  const idx = await nextIdx(db)
  const now = Date.now()
  const sent = text.slice(0, 100)

  // 1. Enumerate every (i,j) pair within window-of-5 and collapse duplicates
  //    by pk. Sum scores and count occurrences so we reproduce the original
  //    "ingest the same pk N times in one message" behavior in one shot.
  interface PairAgg {
    pk: string
    a: string; b: string
    pa: string; pb: string
    rel: string
    addScore: number   // summed sc across occurrences in this message
    count: number      // reinf bump for this message
  }
  const agg = new Map<string, PairAgg>()
  for (let i = 0; i < tokens.length; i++) {
    const stop = Math.min(i + 5, tokens.length)
    for (let j = i + 1; j < stop; j++) {
      const a = tokens[i]
      const b = tokens[j]
      const pk = pairKey(a.word, b.word)
      const sc = scoreOf(a.spos, b.spos, j - i - 1)
      const prev = agg.get(pk)
      if (prev) {
        prev.addScore = Math.min(1, prev.addScore + sc)
        prev.count++
      } else {
        // pairKey sorts, so make sure the stored (a,b,pa,pb) matches the
        // sorted order — same convention as the original per-pair path
        // (which used whatever a/b happened to be in token-index order;
        // the row only sees them via `pk` lookups, so either is fine, but
        // sorted is more predictable for debugging).
        const sorted = a.word <= b.word
        agg.set(pk, {
          pk,
          a:  sorted ? a.word : b.word,
          b:  sorted ? b.word : a.word,
          pa: sorted ? a.pos  : b.pos,
          pb: sorted ? b.pos  : a.pos,
          rel: `${a.spos}+${b.spos}`,
          addScore: sc,
          count: 1,
        })
      }
    }
  }
  if (!agg.size) return
  const pks = Array.from(agg.keys())

  // 2. One lookup across all three tiers. ANY($1::text[]) hits idx_*_pk.
  const { rows: existingRows } = await db.query(
    `SELECT pk, id, score, reinf, created, 'long'   AS tier FROM memory_long   WHERE pk = ANY($1::text[])
     UNION ALL
     SELECT pk, id, score, reinf, created, 'medium' AS tier FROM memory_medium WHERE pk = ANY($1::text[])
     UNION ALL
     SELECT pk, id, score, reinf, created, 'short'  AS tier FROM memory_short  WHERE pk = ANY($1::text[])`,
    [pks]
  )
  const known = new Map<string, { id: string; score: number; reinf: number; created: number; tier: Tier }>()
  for (const r of existingRows as Array<{ pk: string; id: string; score: number; reinf: number; created: number; tier: Tier }>) {
    known.set(r.pk, {
      id: String(r.id),
      score: Number(r.score),
      reinf: Number(r.reinf),
      created: Number(r.created),
      tier: r.tier,
    })
  }

  // 3. Bucket every pair into one of four outcomes:
  //      newInserts[dest]                — brand-new row
  //      updates[same]                   — existing, no tier change
  //      moves[old → new]                — existing, tier change (DELETE+INSERT)
  //    Then issue at most one query per non-empty bucket.
  interface InsertRow {
    id: string; pk: string; a: string; b: string; pa: string; pb: string; rel: string
    score: number; reinf: number; decay_at: number; created: number
  }
  interface UpdateRow {
    pk: string; score: number; reinf: number; decay_at: number
  }
  const newInserts: Record<Tier, InsertRow[]> = { short: [], medium: [], long: [] }
  const sameTierUpdates: Record<Tier, UpdateRow[]> = { short: [], medium: [], long: [] }
  const moveDeletes: Record<Tier, string[]> = { short: [], medium: [], long: [] }   // by source tier
  const moveInserts: Record<Tier, InsertRow[]> = { short: [], medium: [], long: [] } // by dest tier

  for (const p of Array.from(agg.values())) {
    const ex = known.get(p.pk)
    if (ex) {
      const newScore = Math.min(1, ex.score + p.addScore)
      const newTier  = tierOf(newScore)
      const decay_at = idx + 200
      const reinf    = ex.reinf + p.count
      if (newTier === ex.tier) {
        sameTierUpdates[newTier].push({ pk: p.pk, score: newScore, reinf, decay_at })
      } else {
        moveDeletes[ex.tier].push(p.pk)
        moveInserts[newTier].push({
          id: ex.id, pk: p.pk, a: p.a, b: p.b, pa: p.pa, pb: p.pb, rel: p.rel,
          score: newScore, reinf, decay_at, created: ex.created,
        })
      }
    } else {
      const newTier  = tierOf(p.addScore)
      const decay_at = idx + 100
      newInserts[newTier].push({
        id: randomUUID(), pk: p.pk, a: p.a, b: p.b, pa: p.pa, pb: p.pb, rel: p.rel,
        score: p.addScore, reinf: p.count, decay_at, created: now,
      })
    }
  }

  // 4. Flush each non-empty bucket as a single statement.
  for (const tier of TIERS) {
    if (moveDeletes[tier].length) {
      await db.query(`DELETE FROM ${TABLE[tier]} WHERE pk = ANY($1::text[])`, [moveDeletes[tier]])
    }
  }
  for (const tier of TIERS) {
    const rows = newInserts[tier].concat(moveInserts[tier])
    if (rows.length) await bulkInsert(db, tier, rows, sent, idx, now)
  }
  for (const tier of TIERS) {
    if (sameTierUpdates[tier].length) await bulkUpdate(db, tier, sameTierUpdates[tier], idx, now)
  }
}

interface BulkInsertRow {
  id: string; pk: string; a: string; b: string; pa: string; pb: string; rel: string
  score: number; reinf: number; decay_at: number; created: number
}

// Single batched INSERT for one tier via unnest() of equal-length arrays.
// `sent`, `last_msg`, and `updated` are constants for the whole message, so
// they bind as scalars and aren't unnested.
async function bulkInsert(
  db: PoolClient,
  tier: Tier,
  rows: BulkInsertRow[],
  sent: string,
  lastMsg: number,
  updated: number,
): Promise<void> {
  await db.query(
    `INSERT INTO ${TABLE[tier]}
       (id, pk, w1, w2, p1, p2, rel, sent, score, reinf, decay_at, last_msg, created, updated)
     SELECT id, pk, w1, w2, p1, p2, rel, $12::text,
            score, reinf, decay_at, $13::bigint, created, $14::bigint
       FROM unnest(
         $1::text[],   $2::text[], $3::text[], $4::text[],
         $5::text[],   $6::text[], $7::text[],
         $8::real[],   $9::int[],  $10::bigint[], $11::bigint[]
       ) AS src(id, pk, w1, w2, p1, p2, rel, score, reinf, decay_at, created)
     ON CONFLICT (pk) DO UPDATE SET
       w1=EXCLUDED.w1, w2=EXCLUDED.w2, p1=EXCLUDED.p1, p2=EXCLUDED.p2,
       rel=EXCLUDED.rel, sent=EXCLUDED.sent, score=EXCLUDED.score,
       reinf=EXCLUDED.reinf, decay_at=EXCLUDED.decay_at,
       last_msg=EXCLUDED.last_msg, updated=EXCLUDED.updated`,
    [
      rows.map(r => r.id),         // $1
      rows.map(r => r.pk),         // $2
      rows.map(r => r.a),          // $3 w1
      rows.map(r => r.b),          // $4 w2
      rows.map(r => r.pa),         // $5 p1
      rows.map(r => r.pb),         // $6 p2
      rows.map(r => r.rel),        // $7
      rows.map(r => r.score),      // $8
      rows.map(r => r.reinf),      // $9
      rows.map(r => r.decay_at),   // $10
      rows.map(r => r.created),    // $11
      sent,                        // $12
      lastMsg,                     // $13
      updated,                     // $14
    ]
  )
}

// Same-tier reinforcement. Only volatile columns change; w1/w2/p1/p2/rel/sent
// stay put (pk fully determines sorted-(w1,w2)).
async function bulkUpdate(
  db: PoolClient,
  tier: Tier,
  rows: Array<{ pk: string; score: number; reinf: number; decay_at: number }>,
  lastMsg: number,
  updated: number,
): Promise<void> {
  await db.query(
    `UPDATE ${TABLE[tier]} AS t SET
       score    = src.score,
       reinf    = src.reinf,
       decay_at = src.decay_at,
       last_msg = $5::bigint,
       updated  = $6::bigint
       FROM unnest($1::text[], $2::real[], $3::int[], $4::bigint[])
         AS src(pk, score, reinf, decay_at)
      WHERE t.pk = src.pk`,
    [
      rows.map(r => r.pk),
      rows.map(r => r.score),
      rows.map(r => r.reinf),
      rows.map(r => r.decay_at),
      lastMsg,
      updated,
    ]
  )
}

// ── Search (single-word convenience; still 3 tier queries) ───────────────────
// Kept for tests and ad-hoc callers. Hot paths use recallCorrelations which
// folds all tokens into a single UNION-ALL query.
export async function search(db: PoolClient, word: string, perTier = 10): Promise<Correlation[]> {
  const w = String(word ?? '').toLowerCase()
  if (!w) return []
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT *, 'long'::text   AS _tier FROM memory_long   WHERE w1 = $1 OR w2 = $1 ORDER BY score DESC LIMIT $2
     ) UNION ALL SELECT * FROM (
       SELECT *, 'medium'::text AS _tier FROM memory_medium WHERE w1 = $1 OR w2 = $1 ORDER BY score DESC LIMIT $2
     ) UNION ALL SELECT * FROM (
       SELECT *, 'short'::text  AS _tier FROM memory_short  WHERE w1 = $1 OR w2 = $1 ORDER BY score DESC LIMIT $2
     )`,
    [w, perTier]
  )
  return (rows as Array<Record<string, unknown> & { _tier: Tier }>).map(r => rowToCorrelation(r, r._tier))
}

// Extract recall tokens from free text — same filter as the per-pair tokenizer
// uses (length > 2, not a stop word) but matches the original `memoryContext`
// regex split.
function recallTokens(text: string, maxTokens = 5): string[] {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPS.has(w))
    .slice(0, maxTokens)
}

// ── Batched recall (replaces per-token loop over `search`) ───────────────────
// One UNION-ALL across all three tiers and all tokens. Up to 5 tokens × 3
// tiers = up to 15 queries collapsed into one. Result deduped by id, capped
// at maxOut. Tier ordering preserved (long → medium → short within a score
// band) so the recall sentence still prefers durable pairs.
export async function recallCorrelations(db: PoolClient, text: string, maxOut = 10): Promise<Correlation[]> {
  const tokens = recallTokens(text)
  if (!tokens.length) return []
  // Per-tier internal LIMIT keeps row volume bounded when a token is wildly
  // common (e.g. 'cipher' after months of traffic). 5× maxOut is plenty.
  const perTierLimit = Math.max(maxOut * 5, 20)
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT *, 'long'::text   AS _tier, 0 AS _order FROM memory_long   WHERE w1 = ANY($1::text[]) OR w2 = ANY($1::text[]) ORDER BY score DESC LIMIT $2
     ) l UNION ALL SELECT * FROM (
       SELECT *, 'medium'::text AS _tier, 1 AS _order FROM memory_medium WHERE w1 = ANY($1::text[]) OR w2 = ANY($1::text[]) ORDER BY score DESC LIMIT $2
     ) m UNION ALL SELECT * FROM (
       SELECT *, 'short'::text  AS _tier, 2 AS _order FROM memory_short  WHERE w1 = ANY($1::text[]) OR w2 = ANY($1::text[]) ORDER BY score DESC LIMIT $2
     ) s
     ORDER BY _order ASC, score DESC`,
    [tokens, perTierLimit]
  )
  const seen = new Set<string>()
  const out: Correlation[] = []
  for (const r of rows as Array<Record<string, unknown> & { _tier: Tier; id: string }>) {
    const id = String(r.id)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(rowToCorrelation(r, r._tier))
    if (out.length >= maxOut) break
  }
  return out
}

// Recall sentence — now a thin wrapper around recallCorrelations so the
// correlation channel of `recall()` only fires the UNION-ALL once and both
// outputs share the same row set.
export async function memoryContext(db: PoolClient, text: string, maxOut = 10): Promise<string> {
  const hits = await recallCorrelations(db, text, maxOut)
  if (!hits.length) return ''
  return 'Things you remember: ' +
    hits.map(c => `${c.w1} and ${c.w2} are connected`).join('; ') + '.'
}

// ── Decay sweep (Lila addition; 2dkira defines decay_at but never sweeps) ────
// Run once per maintenance cycle. For each row whose lease expired
// (last_msg + (decay_at - last_msg) < counter, i.e. decay_at < counter):
//   - multiply score by per-tier rate (slower for long, faster for short)
//   - re-tier; if score < FLOOR, delete the row
// Returns counts of evicted rows per tier.
const DECAY_RATE: Record<Tier, number> = {
  short:  0.85,   // -15% per sweep — short tier evaporates fast
  medium: 0.93,
  long:   0.97,   // -3% per sweep — long-tier rows are durable
}
const FLOOR = 0.05  // below this, evict entirely

export async function runDecay(db: PoolClient): Promise<{ short: number; medium: number; long: number; demoted: number }> {
  const { rows: [s] } = await db.query(`SELECT counter FROM memory_state WHERE id = 1`)
  const counter = Number(s?.counter ?? 0)
  const now = Date.now()
  const summary = { short: 0, medium: 0, long: 0, demoted: 0 }

  for (const t of TIERS) {
    const rate = DECAY_RATE[t]
    const { rows } = await db.query(
      `SELECT id, pk, w1, w2, p1, p2, rel, sent, score, reinf, decay_at, last_msg, created
         FROM ${TABLE[t]}
        WHERE decay_at IS NOT NULL AND decay_at < $1`,
      [counter]
    )
    for (const r of rows) {
      const newScore = Number(r.score) * rate
      if (newScore < FLOOR) {
        await db.query(`DELETE FROM ${TABLE[t]} WHERE id = $1`, [r.id])
        summary[t]++
        continue
      }
      const newTier = tierOf(newScore)
      // Renew the lease so we don't re-decay the same row every sweep.
      const newDecayAt = counter + (t === 'long' ? 1000 : t === 'medium' ? 200 : 100)
      if (newTier !== t) {
        await db.query(`DELETE FROM ${TABLE[t]} WHERE id = $1`, [r.id])
        await db.query(
          `INSERT INTO ${TABLE[newTier]}
             (id, pk, w1, w2, p1, p2, rel, sent, score, reinf, decay_at, last_msg, created, updated)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (pk) DO NOTHING`,
          [r.id, r.pk, r.w1, r.w2, r.p1, r.p2, r.rel, r.sent, newScore, r.reinf, newDecayAt, r.last_msg, r.created, now]
        )
        summary.demoted++
      } else {
        await db.query(
          `UPDATE ${TABLE[t]} SET score = $1, decay_at = $2, updated = $3 WHERE id = $4`,
          [newScore, newDecayAt, now, r.id]
        )
      }
    }
  }
  await db.query(
    `UPDATE memory_state
        SET last_decay_short_at = NOW(),
            last_decay_medium_at = NOW(),
            last_decay_long_at = NOW(),
            updated_at = NOW()
      WHERE id = 1`
  )
  return summary
}
