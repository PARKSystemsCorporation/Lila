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

// ── Find an existing pair across all three tiers (long → medium → short) ─────
async function findExisting(db: PoolClient, pk: string): Promise<{ row: Correlation; tier: Tier } | null> {
  for (const t of TIERS) {
    const { rows } = await db.query(`SELECT * FROM ${TABLE[t]} WHERE pk = $1 LIMIT 1`, [pk])
    if (rows.length) return { row: rowToCorrelation(rows[0], t), tier: t }
  }
  return null
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

// ── Ingestion (verbatim port of 2dkira `processMsg`) ─────────────────────────
// 2dkira filters out non-user messages: `if (source !== 'user') return`. We
// preserve that gate — system signals (web fetches, agent notes) only feed
// episodes/memory_messages, not the correlation graph, to keep the graph
// shaped by real conversational language.
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

  for (let i = 0; i < tokens.length; i++) {
    const stop = Math.min(i + 5, tokens.length)  // 2dkira window of 5
    for (let j = i + 1; j < stop; j++) {
      const a = tokens[i]
      const b = tokens[j]
      const pk = pairKey(a.word, b.word)
      const sc = scoreOf(a.spos, b.spos, j - i - 1)
      const rel = `${a.spos}+${b.spos}`
      const sent = text.slice(0, 100)

      const existing = await findExisting(db, pk)

      if (existing) {
        const newScore = Math.min(1, existing.row.score + sc)
        const newTier = tierOf(newScore)
        if (newTier !== existing.tier) {
          await db.query(`DELETE FROM ${TABLE[existing.tier]} WHERE pk = $1`, [pk])
        }
        await db.query(
          `INSERT INTO ${TABLE[newTier]}
             (id, pk, w1, w2, p1, p2, rel, sent, score, reinf, decay_at, last_msg, created, updated)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (pk) DO UPDATE SET
             w1=EXCLUDED.w1, w2=EXCLUDED.w2, p1=EXCLUDED.p1, p2=EXCLUDED.p2,
             rel=EXCLUDED.rel, sent=EXCLUDED.sent, score=EXCLUDED.score,
             reinf=EXCLUDED.reinf, decay_at=EXCLUDED.decay_at,
             last_msg=EXCLUDED.last_msg, updated=EXCLUDED.updated`,
          [
            existing.row.id, pk, a.word, b.word, a.pos, b.pos, rel,
            sent, newScore, existing.row.reinf + 1, idx + 200, idx,
            existing.row.created, now,
          ]
        )
      } else {
        const t = tierOf(sc)
        await db.query(
          `INSERT INTO ${TABLE[t]}
             (id, pk, w1, w2, p1, p2, rel, sent, score, reinf, decay_at, last_msg, created, updated)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (pk) DO NOTHING`,
          [
            randomUUID(), pk, a.word, b.word, a.pos, b.pos, rel,
            sent, sc, 1, idx + 100, idx, now, now,
          ]
        )
      }
    }
  }
}

// ── Search (verbatim port of 2dkira `search`) ────────────────────────────────
export async function search(db: PoolClient, word: string, perTier = 10): Promise<Correlation[]> {
  const w = String(word ?? '').toLowerCase()
  if (!w) return []
  const out: Correlation[] = []
  for (const t of TIERS) {
    const { rows } = await db.query(
      `SELECT * FROM ${TABLE[t]} WHERE w1 = $1 OR w2 = $1 ORDER BY score DESC LIMIT $2`,
      [w, perTier]
    )
    for (const r of rows) out.push(rowToCorrelation(r, t))
  }
  return out
}

// ── Recall sentence (verbatim port of 2dkira `memoryContext`) ────────────────
export async function memoryContext(db: PoolClient, text: string, maxOut = 10): Promise<string> {
  const words = String(text ?? '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPS.has(w))
  if (!words.length) return ''
  const results: Correlation[] = []
  for (const w of words.slice(0, 5)) {
    results.push(...await search(db, w))
  }
  // Dedupe by id, cap at maxOut.
  const unique = Array.from(new Map(results.map(r => [r.id, r] as const)).values()).slice(0, maxOut)
  if (!unique.length) return ''
  return 'Things you remember: ' +
    unique.map(c => `${c.w1} and ${c.w2} are connected`).join('; ') + '.'
}

// Same flavor of recall but returns the raw rows so callers can rank/render.
export async function recallCorrelations(db: PoolClient, text: string, maxOut = 10): Promise<Correlation[]> {
  const words = String(text ?? '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPS.has(w))
  if (!words.length) return []
  const results: Correlation[] = []
  for (const w of words.slice(0, 5)) {
    results.push(...await search(db, w))
  }
  return Array.from(new Map(results.map(r => [r.id, r] as const)).values()).slice(0, maxOut)
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
