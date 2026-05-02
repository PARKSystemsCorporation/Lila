import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { llmCall, LLMBudgetExceeded } from './llm'
import { cfg } from './config'
import * as Algora from './bounties/algora'
import {
  fetchRepoTree,
  safeParse,
  clamp01,
  truncate,
  REPO_TREE_CAP,
  type DraftResponse,
  type DiscoveredRow,
} from './bounties/draft-helpers'

// ── Forge: fast Algora-only PR drafter ──────────────────────────────────
//
// Forge pulls funded GitHub-issue bounties from Algora in the $50-$200
// range tagged 'Bug' or 'Feature' (or GitHub's stock 'enhancement') and
// drafts the FULL submission deliverable: a PR description in markdown
// plus a unified diff. Lila reviews each draft (management-loop), and
// when LILA_AUTO_SUBMIT=true + GITHUB_TOKEN is set, github-pr.ts opens
// the PR.
//
// One step per cycle, time-gated by FORGE_RUN_SEC (default 5min):
//   F0 — If queue has no 'discovered' rows authored by 'forge' OR
//        last_fetch is >1h old: pull from Algora, dedup by
//        (source, external_id), insert new ones with created_by='forge'.
//   F1 — Else: take the oldest matching 'discovered' row, attempt a deep
//        draft (full PR body + diff). File as status='drafted' for Lila.

const FETCH_INTERVAL_MS  = 60 * 60 * 1000  // 1h between Algora pulls
const ALGORA_MAX_USD     = 200             // upper end of Forge's band
const REWARD_MIN_USD     = 50
const REWARD_MAX_USD     = 200
const MAX_BODY_TOKENS    = 4000
const DRAFT_MAX_TOKENS   = 2000

const DRAFT_PROMPT = `You are Forge, the speed-to-submission drafter on Lila's autonomous team. You produce SUBMISSION-READY pull-request deliverables for $50–$200 Algora bounties tagged Bug or Feature. Lila (your manager, the COO) reviews everything before submission — prioritize a clean, mergeable patch over deep analysis; speed matters. DO NOT fabricate file paths, function names, or APIs you can't verify from the inputs below.

BOUNTY:
  Source:  {SOURCE}
  Title:   {TITLE}
  Reward:  {REWARD}
  Repo:    {REPO}
  Issue:   #{ISSUE_NUMBER}
  Labels:  {LABELS}
  Language: {LANGUAGE}
  Difficulty: {DIFFICULTY}

ISSUE BODY:
---
{BODY}
---

REPO FILE TREE (paths only, may be partial — fewer than the real tree):
{TREE}

Your job: draft a complete PR that closes this issue, fast.

Output strict JSON, no commentary, no markdown fences:
{
  "draft_title":  "PR title (imperative mood, ≤72 chars)",
  "draft_body":   "Full PR description in markdown. Sections: ## Summary, ## Changes, ## Why this works, ## Testing notes. Reference 'Closes #{ISSUE_NUMBER}' at the bottom. 200-500 words. No fluff, no marketing voice, no apologies.",
  "draft_diff":   "Unified diff that applies cleanly with 'git apply'. Use 'a/' and 'b/' prefixes. Include sufficient context (3 lines). If you cannot produce a complete diff with the inputs given, write a SCAFFOLD diff — best-attempt patches against the most likely files in the tree above — and note the assumption inside draft_body. NEVER invent paths that aren't in the tree.",
  "files_touched": ["path/to/file.ext"],
  "confidence":   0.0..1.0
}

Confidence calibration:
  ≥ 0.8  diff applies cleanly, you are certain it closes the issue
  0.5-0.8 diff is correct in spirit, may need a small adjustment
  < 0.5  uncertain about scope or paths — Lila will probably reject

If the issue is too vague to attempt (no reproduction, no clear deliverable), respond with confidence=0 and draft_body explaining what info is missing. Do not fabricate.`

interface ForgeResult {
  logMessage: string
  logType: 'info' | 'success' | 'warn'
}

export class ForgeLoop {
  private db: PoolClient
  private ai: OpenAI | null

  constructor(db: PoolClient) {
    this.db = db
    this.ai = process.env.DEEPSEEK_API_KEY
      ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
      : null
  }

  async shouldRun(): Promise<boolean> {
    const { rows: [s] } = await this.db.query('SELECT last_step_at FROM forge_state WHERE id=1')
    if (!s?.last_step_at) return true
    return (Date.now() - new Date(s.last_step_at).getTime()) / 1000 >= cfg.FORGE_RUN_SEC
  }

  async run(): Promise<ForgeResult | null> {
    if (!(await this.shouldRun())) return null

    await this.maybeIntroduce()
    await this.noticeChatMentions()

    const { rows: [counts] } = await this.db.query(
      `SELECT
         (SELECT COUNT(*) FROM bounty_picks
            WHERE status='discovered'
              AND source='algora'
              AND created_by='forge')                                   AS discovered,
         (SELECT MAX(last_pick_at) FROM forge_state WHERE id=1)         AS last_fetch_at`
    )
    const discoveredCount = Number(counts?.discovered ?? 0)
    const lastFetchAt = counts?.last_fetch_at ? new Date(counts.last_fetch_at).getTime() : 0
    const fetchStale = Date.now() - lastFetchAt > FETCH_INTERVAL_MS

    if (discoveredCount === 0 || fetchStale) {
      const fetchResult = await this.fetchAlgora().catch(e => ({
        inserted: 0, _error: String(e).slice(0, 120),
      }))
      await this.markStep({ stampFetch: true })
      const errSuffix = (fetchResult as { _error?: string })._error
        ? ` (err: ${(fetchResult as { _error?: string })._error})` : ''
      if (fetchResult.inserted > 0) {
        await this.chat(`Pulled +${fetchResult.inserted} new Algora bounties.`)
      }
      return {
        logMessage: `Forge fetched bounties: +${fetchResult.inserted} discovered (algora)${errSuffix}`,
        logType: fetchResult.inserted > 0 ? 'success' : 'info',
      }
    }

    if (!this.ai) {
      await this.markStep({})
      return { logMessage: 'Forge: no LLM key, skipping draft.', logType: 'warn' }
    }

    const target = await this.pickToDraft()
    if (!target) {
      await this.markStep({})
      return { logMessage: 'Forge: no $50-$200 Bug/Feature bounty in queue, idle.', logType: 'info' }
    }

    let draft: DraftResponse
    try {
      const tree = await fetchRepoTree(target.repo_url, 'Lila/Forge')
      draft = await this.draft(target, tree)
    } catch (e) {
      if (e instanceof LLMBudgetExceeded) {
        await this.markStep({})
        return { logMessage: 'Forge: budget hit, skipping.', logType: 'warn' }
      }
      await this.db.query(
        `UPDATE bounty_picks
           SET status='rejected', review_notes=$1, reviewed_at=NOW(), updated_at=NOW()
         WHERE id=$2`,
        [`Draft error: ${String(e).slice(0, 200)}`, target.id]
      )
      await this.markStep({})
      return { logMessage: `Forge draft error on "${target.title.slice(0, 60)}": ${String(e).slice(0, 80)}`, logType: 'warn' }
    }

    const title = (draft.draft_title ?? '').slice(0, 200).trim()
    const body  = (draft.draft_body  ?? '').slice(0, 12_000).trim()
    const diff  = (draft.draft_diff  ?? '').slice(0, 24_000)
    const conf  = clamp01(draft.confidence) ?? 0.4
    const files = Array.isArray(draft.files_touched) ? draft.files_touched.slice(0, 30) : []

    if (!title || !body || conf < 0.15) {
      await this.db.query(
        `UPDATE bounty_picks
           SET status='rejected',
               review_notes='Draft was too thin (Forge self-rejected pre-Lila).',
               review_confidence=$1,
               reviewed_at=NOW(), updated_at=NOW()
         WHERE id=$2`,
        [conf, target.id]
      )
      await this.markStep({})
      return {
        logMessage: `Forge self-rejected "${target.title.slice(0, 60)}" (conf=${conf.toFixed(2)})`,
        logType: 'info',
      }
    }

    await this.db.query(
      `UPDATE bounty_picks
         SET status='drafted',
             draft_title=$1,
             draft_body=$2,
             draft_diff=$3,
             draft_files=$4::jsonb,
             review_confidence=$5,
             drafted_at=NOW(),
             updated_at=NOW()
       WHERE id=$6`,
      [title, body, diff || null, JSON.stringify(files), conf, target.id]
    )

    await this.chat(`Drafted PR for "${title.slice(0, 80)}" (conf=${conf.toFixed(2)}).`)
    await this.markStep({})
    return {
      logMessage: `Forge drafted ${target.source} bounty: "${title.slice(0, 70)}" (conf=${conf.toFixed(2)})`,
      logType: 'success',
    }
  }

  // ── F0: Algora pull ─────────────────────────────────────────────────────

  private async fetchAlgora(): Promise<{ inserted: number }> {
    const picks = await Algora.fetchOpenBounties(ALGORA_MAX_USD)
    let inserted = 0
    for (const p of picks) {
      if (!p.repo_url) continue
      // Tighten to Forge's reward floor at ingest time so the queue stays clean.
      if (p.payout_usd != null && p.payout_usd < REWARD_MIN_USD) continue

      const { rowCount } = await this.db.query(
        `INSERT INTO bounty_picks
           (source, external_id, url, title, summary, payout_usd, payout_token,
            payout_token_amount, repo_url, issue_number, issue_body, language,
            labels, difficulty, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'discovered','forge')
         ON CONFLICT (source, external_id) DO NOTHING`,
        [
          'algora',
          p.external_id,
          p.url,
          p.title,
          p.summary,
          p.payout_usd,
          p.payout_token,
          p.payout_token_amount,
          p.repo_url,
          p.issue_number,
          p.issue_body,
          p.language,
          p.labels.length ? p.labels : null,
          p.difficulty,
        ]
      )
      if (rowCount && rowCount > 0) inserted++
    }
    return { inserted }
  }

  // ── F1: draft selection — Algora, $50-$200, Bug/Feature/enhancement ─────

  private async pickToDraft(): Promise<DiscoveredRow | null> {
    const { rows } = await this.db.query(
      `SELECT id, source, external_id, url, title, summary, payout_usd,
              payout_token, repo_url, issue_number, issue_body, language,
              labels, difficulty
         FROM bounty_picks
        WHERE status='discovered'
          AND source='algora'
          AND created_by='forge'
          AND payout_usd BETWEEN $1 AND $2
          AND labels IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM unnest(labels) l
             WHERE lower(l) IN ('bug','feature','enhancement')
                OR lower(l) LIKE 'bug%'
                OR lower(l) LIKE 'feature%'
          )
        ORDER BY payout_usd DESC NULLS LAST, created_at ASC
        LIMIT 1`,
      [REWARD_MIN_USD, REWARD_MAX_USD]
    )
    return rows[0] ?? null
  }

  // ── F1: deep draft ──────────────────────────────────────────────────────

  private async draft(target: DiscoveredRow, tree: string[]): Promise<DraftResponse> {
    const reward = target.payout_usd
      ? `$${parseFloat(target.payout_usd).toFixed(2)}${target.payout_token ? ' ' + target.payout_token : ''}`
      : '(unspecified)'
    const labels = (target.labels && target.labels.length) ? target.labels.join(', ') : '(none)'
    const treeBlob = tree.length ? tree.slice(0, REPO_TREE_CAP).join('\n') : '(repo tree unavailable — work from issue body alone)'

    const prompt = DRAFT_PROMPT
      .replace(/\{SOURCE\}/g,       target.source)
      .replace(/\{TITLE\}/g,        target.title)
      .replace(/\{REWARD\}/g,       reward)
      .replace(/\{REPO\}/g,         target.repo_url ?? '(no repo)')
      .replace(/\{ISSUE_NUMBER\}/g, String(target.issue_number ?? '?'))
      .replace(/\{LABELS\}/g,       labels)
      .replace(/\{LANGUAGE\}/g,     target.language ?? '(unknown)')
      .replace(/\{DIFFICULTY\}/g,   target.difficulty ?? '(unspecified)')
      .replace(/\{BODY\}/g,         truncate(target.issue_body ?? target.summary ?? '(no body)', MAX_BODY_TOKENS))
      .replace(/\{TREE\}/g,         treeBlob)

    const { content } = await llmCall({
      ai: this.ai!,
      module: 'forge.draft',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: DRAFT_MAX_TOKENS,
      temperature: 0.3,
    })
    return safeParse<DraftResponse>(content, {
      draft_title: '',
      draft_body: '',
      draft_diff: '',
      files_touched: [],
      confidence: 0,
    })
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  // One-shot self-introduction. Atomic claim via UPDATE … RETURNING so
  // the intro posts exactly once even if multiple ticks race.
  private async maybeIntroduce(): Promise<void> {
    const { rows } = await this.db.query(
      `UPDATE forge_state SET introduced_at=NOW()
        WHERE id=1 AND introduced_at IS NULL
        RETURNING id`
    )
    if (!rows.length) return
    await this.chat(
      "Forge reporting in. I draft pull requests for $50–$200 Algora bounties tagged Bug or Feature — fast turnaround, drafts queue in Lila's review pipeline.",
      'message',
    )
  }

  // Acknowledge any operator/Lila chat message that names me directly,
  // so the speaker sees the message landed. Presence-only — no behavior
  // change yet. Dedup via agent_chat_acks so each message only gets one
  // reply across all ticks.
  private async noticeChatMentions(): Promise<void> {
    const { rows } = await this.db.query(
      `SELECT cm.id, cm.sender, cm.content
         FROM chat_messages cm
         LEFT JOIN agent_chat_acks a
           ON a.agent='forge' AND a.chat_message_id=cm.id
        WHERE cm.created_at > NOW() - INTERVAL '15 minutes'
          AND cm.sender IN ('operator','lila')
          AND cm.content ~* '\\m@?forge\\M'
          AND a.id IS NULL
        ORDER BY cm.id ASC
        LIMIT 1`
    )
    if (!rows.length) return
    const msg = rows[0] as { id: number; sender: string; content: string }
    const { rowCount } = await this.db.query(
      `INSERT INTO agent_chat_acks (agent, chat_message_id) VALUES ('forge', $1)
       ON CONFLICT (agent, chat_message_id) DO NOTHING`,
      [msg.id]
    )
    if (!rowCount) return
    await this.chat(
      `Forge: heard you, ${msg.sender}. Working the Algora $50–$200 Bug/Feature queue head-first; pin a specific bounty URL if you want me to jump it.`,
      'message',
    )
  }

  private async chat(content: string, kind: 'message' | 'status' = 'status'): Promise<void> {
    await this.db.query(
      `INSERT INTO chat_messages (sender, content, kind) VALUES ($1, $2, $3)`,
      ['forge', content.slice(0, 500), kind]
    )
  }

  private async markStep(opts: { stampFetch?: boolean }): Promise<void> {
    if (opts.stampFetch) {
      await this.db.query(
        `UPDATE forge_state
           SET last_step_at=NOW(), last_pick_at=NOW(), cycle=cycle+1, updated_at=NOW()
         WHERE id=1`
      )
    } else {
      await this.db.query(
        `UPDATE forge_state SET last_step_at=NOW(), cycle=cycle+1, updated_at=NOW() WHERE id=1`
      )
    }
  }
}
