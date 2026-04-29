import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import * as Alpaca from './platforms/alpaca'
import { llmCall, LLMBudgetExceeded } from './llm'
import { cfg } from './config'

// ── Management Lila ──────────────────────────────────────────────────────────
//
// Lila handles the high-stakes work on top of Cipher's bounty grind:
//   1. Operator replies    — direct-line responses in chat
//   2. Report review       — vets Cipher's pending_review reports before the
//                            operator sees anything (approve / reject with notes)
//   3. Trade cycle         — her own trading decisions, every ~15 min:
//                            review Vega notes, file plan with tight stops,
//                            close/trim open positions, post update
//   4. Proactive check-in  — morale / flags / wins, every ~5 min
//
// Each run returns after the first priority that fires, keeping token cost
// bounded. She never ticks unprompted — work must be there.

const BIG_WIN_THRESHOLD = 50
const ERROR_THRESHOLD   = 3

type LogType = 'info' | 'success' | 'warn'

export interface ManagementResult {
  logMessage: string
  logType: LogType
  posted: boolean
}

const REPLY_PROMPT = `You are Lila, the manager of a small autonomous team: Cipher (bounty executor) and Vega (market intel). You report to the operator.

Voice: direct, dry, warm-but-not-soft. CEO briefing an investor. Numbers first. No filler, no hedging, no apologies.

Team state right now:
{CONTEXT}

Recent chat (latest last):
{TRANSCRIPT}

The most recent operator message is unanswered. Write a single reply (1-3 sentences) addressing it directly. Use the numbers above. If they're pushing for action, commit to it. Don't repeat the context back at them.`

const PROACTIVE_PROMPT = `You are Lila, managing Cipher and Vega. Report to the operator.

State:
{CONTEXT}

Notable event: {EVENT}

Write ONE short message (1-2 sentences) — morale note to the team or heads-up to the operator, whichever fits. Direct, dry.`

const SECURITY_REVIEW_PROMPT = `You are Lila reviewing a security-bug report Cipher just drafted. Before it reaches the operator it passes through you. Your job is to catch fabrication, overreach, and unjustified severity.

Bounty: {TITLE} · ${'${REWARD}'} on {PLATFORM}

Cipher's report:
---
{REPORT}
---

Evaluate:
1. Is the finding concrete — does it reference a real component/function and a real failure mode?
2. Is severity justified? Critical/High needs a direct asset-loss path.
3. Is the PoC plausible? Obvious hand-waving or "this could potentially allow" language is a red flag.
4. Any obvious fabrication (invented function names, invented code)?

Respond with ONLY valid JSON:
{
  "decision": "approve" | "reject",
  "confidence": 0.0-1.0,
  "notes": "one sentence for the operator"
}

Approve only if you'd submit this yourself. Reject with the actual reason. No "looks good" — give a reason either way.`

const BOUNTY_REVIEW_PROMPT = `You are Lila, COO of PARKSystems Corporation. Scout just drafted a pull-request submission for a sub-$500 GitHub bounty. You are the only review gate before this PR is opened under the company GitHub account. Be strict. A bad submission damages the company's reputation; a fabricated diff or a low-effort write-up gets us blacklisted from the platform.

Bounty: {TITLE} · {REWARD} on {SOURCE}
Repo:   {REPO}
Issue:  #{ISSUE_NUMBER}

Scout's draft confidence: {CONFIDENCE}

PR title (Scout's draft): {DRAFT_TITLE}

PR body (Scout's draft):
---
{DRAFT_BODY}
---

Diff (truncated):
---
{DRAFT_DIFF}
---

Evaluate, in this order:
1. Does the draft actually address what the issue asked for, or is Scout speculating?
2. Is the diff plausible? Real-looking paths, syntactically reasonable, no obviously invented APIs.
3. Are claims in the body consistent with what the diff actually changes? No "fixed X" without a corresponding hunk.
4. Would you, as COO, be comfortable having this PR opened under our company name?

Approve only if you'd ship it yourself. Reject anything that's vague, fabricated, or scope-mismatched. The cost of rejecting is one cycle; the cost of submitting garbage is reputation. Default lean: reject when uncertain.

Respond with ONLY valid JSON:
{
  "decision":   "approve" | "reject",
  "confidence": 0.0-1.0,
  "notes":      "one sentence — what Scout got right or where it failed"
}`

const DOCS_REVIEW_PROMPT = `You are Lila reviewing technical documentation Cipher just drafted for a paid bounty. Before it reaches the operator it passes through you.

Bounty: {TITLE} · ${'${REWARD}'} on {PLATFORM}

Cipher's draft:
---
{REPORT}
---

Evaluate:
1. Does it actually answer what the bounty asked for, or did Cipher invent scope?
2. Are code samples syntactically valid and minimal? No hallucinated APIs, no broken imports.
3. Is it publishable quality — clear structure, developer tone, no fluff/marketing language?
4. Tables / examples used where they belong instead of prose?

Respond with ONLY valid JSON:
{
  "decision": "approve" | "reject",
  "confidence": 0.0-1.0,
  "notes": "one sentence for the operator"
}

Approve only if you'd be comfortable submitting this yourself. Reject with the actual reason. No "looks good to me" — give a reason either way.`

const TRADE_PLAN_PROMPT = `You are Lila, running the trading desk. Write today's plan based on Vega output and current positions.

Vega notes (recent):
{NOTES}

Vega pending picks:
{PICKS}

Open positions:
{POSITIONS}

Rules:
- Long only.
- Sizing is agnostic; small-account trades are fine.
- Every trade MUST have a TIGHT stop (close to entry, tight enough that a single bad candle takes you out, not a 7% stop).
- Be aggressive cutting losers. Let winners run only if thesis holds.

Respond with ONLY valid JSON:
{
  "stance": "1-2 sentence read on the market and your posture today",
  "trades": [{"symbol":"XYZ","entry":12.34,"target":13.20,"stop":12.10,"confidence":0.7,"reason":"one sentence"}],
  "positionActions": [{"symbol":"XYZ","action":"HOLD|CLOSE","reason":"one sentence"}]
}`

function today() { return new Date().toISOString().slice(0, 10) }

export class ManagementLoop {
  private db: PoolClient
  private ai: OpenAI | null

  constructor(db: PoolClient) {
    this.db = db
    this.ai = process.env.DEEPSEEK_API_KEY
      ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
      : null
  }

  async run(): Promise<ManagementResult | null> {
    if (!this.ai) return null

    // Priority 1: reply to unanswered operator message
    const reply = await this.replyToOperator()
    if (reply) return reply

    // Priority 2: read & report on any approved desk items the operator
    // hasn't been briefed on yet. One pass per run; processes up to 3
    // items so a backlog clears in a few cycles.
    const desk = await this.processDeskApprovals()
    if (desk) return desk

    // Priority 3: review any pending_review report (one per run)
    const review = await this.reviewOne()
    if (review) return review

    // Priority 3b: review one drafted bounty (Scout's queue)
    const bountyReview = await this.reviewBountyDraft()
    if (bountyReview) return bountyReview

    // Priority 4: trade cycle, 15-min gated
    if (await this.shouldTrade()) {
      const trade = await this.runTradeCycle()
      if (trade) return trade
    }

    // Priority 5: proactive check-in, 5-min gated
    if (!(await this.shouldCheckIn())) return null
    return await this.proactiveCheckIn()
  }

  // ── Priority 2: desk approvals → chat reports ─────────────────────────
  private async processDeskApprovals(): Promise<ManagementResult | null> {
    const Desk = await import('./desk')
    const r = await Desk.processApprovedItems(this.db)
    if (r.reported === 0) return null
    return {
      logMessage: r.logMessage ?? `Lila reported on ${r.reported} desk item(s).`,
      logType: 'success',
      posted: true,
    }
  }

  // ── Priority 1: operator reply ─────────────────────────────────────────────

  private async replyToOperator(): Promise<ManagementResult | null> {
    const { rows } = await this.db.query(
      `SELECT sender, content, created_at FROM chat_messages
       WHERE thread = 'main'
         AND created_at > NOW() - INTERVAL '20 minutes'
       ORDER BY created_at ASC LIMIT 30`
    )
    if (!rows.length) return null

    let lastUserIdx = -1
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].sender === 'user') { lastUserIdx = i; break }
    }
    if (lastUserIdx === -1) return null

    const lilaRepliedAfter = rows.slice(lastUserIdx + 1).some(r => r.sender === 'lila')
    if (lilaRepliedAfter) return null

    const context = await this.context()
    const transcript = rows
      .map((m: { sender: string; content: string }) => `[${m.sender.toUpperCase()}]: ${m.content}`)
      .join('\n')

    const userMsgCreatedAt = rows[lastUserIdx].created_at

    const msg = await this.llm(
      'lila.reply',
      REPLY_PROMPT.replace('{CONTEXT}', context).replace('{TRANSCRIPT}', transcript),
      220
    )
    if (!msg) return null

    // Re-check before insert: another process / tick / streaming /api/chat
    // call may have inserted a Lila reply during our 5-10s LLM call. The
    // initial dedup at the top of this method passed, but the world moves
    // during the LLM round-trip. Without this re-check, multi-instance
    // deploys (Railway rolling deploys, scale-up) will double-reply.
    const { rows: recheck } = await this.db.query(
      `SELECT 1 FROM chat_messages
       WHERE thread='main' AND sender='lila'
         AND created_at > $1::timestamptz
       LIMIT 1`,
      [userMsgCreatedAt]
    )
    if (recheck.length > 0) {
      return { logMessage: 'Reply skipped — another reply landed during LLM call', logType: 'info', posted: false }
    }

    await this.chat('lila', msg.slice(0, 500))
    return { logMessage: 'Lila replied to operator.', logType: 'info', posted: true }
  }

  // ── Priority 2: report review ──────────────────────────────────────────────

  private async reviewOne(): Promise<ManagementResult | null> {
    const { rows } = await this.db.query(
      `SELECT id, title, reward, platform_label, content, kind
       FROM security_reports
       WHERE status='pending_review'
       ORDER BY created_at ASC LIMIT 1`
    )
    if (!rows.length) return null

    const r = rows[0]
    const kind = (r.kind ?? 'security') as 'security' | 'code' | 'docs'

    // Kind-aware review prompt — docs get writing-quality checks, not
    // vulnerability-severity checks.
    const promptTemplate = kind === 'docs' ? DOCS_REVIEW_PROMPT : SECURITY_REVIEW_PROMPT
    const reviewModule = kind === 'docs' ? 'lila.review.docs' : 'lila.review.security'

    const raw = await this.llm(
      reviewModule,
      promptTemplate
        .replace('{TITLE}', r.title)
        .replace('{REWARD}', String(r.reward))
        .replace('{PLATFORM}', r.platform_label)
        .replace('{REPORT}', String(r.content).slice(0, 6000)),
      250
    )
    const parsed = this.parse<{ decision: 'approve' | 'reject'; confidence: number; notes: string }>(
      raw, { decision: 'reject', confidence: 0, notes: 'Review returned no parseable verdict.' }
    )

    const newStatus = parsed.decision === 'approve' ? 'approved' : 'rejected'
    const notes = String(parsed.notes ?? '').slice(0, 500)

    await this.db.query(
      `UPDATE security_reports
         SET status=$1, review_notes=$2, confidence=$3, updated_at=NOW()
       WHERE id=$4`,
      [newStatus, notes, Math.min(Math.max(parsed.confidence ?? 0, 0), 1), r.id]
    )

    const label = kind === 'docs' ? 'docs draft' : 'report'
    if (newStatus === 'approved') {
      await this.chat(
        'lila',
        `Approved ${label}: "${r.title}" — $${r.reward} on ${r.platform_label}. ${notes} Ready in the Reports tab.`
      )
    } else {
      await this.chat(
        'lila',
        `Rejected Cipher's ${label} on "${r.title}". ${notes}`
      )
    }

    return {
      logMessage: `Lila ${newStatus} ${kind} "${r.title}" — ${notes.slice(0, 80)}`,
      logType: newStatus === 'approved' ? 'success' : 'warn',
      posted: true,
    }
  }

  // ── Priority 3b: bounty draft review ──────────────────────────────────────

  private async reviewBountyDraft(): Promise<ManagementResult | null> {
    const { rows } = await this.db.query(
      `SELECT id, source, url, title, repo_url, issue_number, payout_usd, payout_token,
              draft_title, draft_body, draft_diff, review_confidence
         FROM bounty_picks
        WHERE status='drafted'
        ORDER BY drafted_at ASC
        LIMIT 1`
    )
    if (!rows.length) return null
    const r = rows[0]

    const reward = r.payout_usd
      ? `$${parseFloat(r.payout_usd).toFixed(2)}${r.payout_token ? ' ' + r.payout_token : ''}`
      : '(unspecified)'

    const raw = await this.llm(
      'lila.review.bounty',
      BOUNTY_REVIEW_PROMPT
        .replace('{TITLE}',         r.title)
        .replace('{REWARD}',        reward)
        .replace('{SOURCE}',        r.source)
        .replace('{REPO}',          r.repo_url ?? '(no repo)')
        .replace('{ISSUE_NUMBER}',  String(r.issue_number ?? '?'))
        .replace('{CONFIDENCE}',    parseFloat(r.review_confidence ?? '0').toFixed(2))
        .replace('{DRAFT_TITLE}',   r.draft_title ?? '')
        .replace('{DRAFT_BODY}',    String(r.draft_body ?? '').slice(0, 5000))
        .replace('{DRAFT_DIFF}',    String(r.draft_diff ?? '(no diff)').slice(0, 6000)),
      300
    )
    const parsed = this.parse<{ decision: 'approve' | 'reject'; confidence: number; notes: string }>(
      raw, { decision: 'reject', confidence: 0, notes: 'Bounty review returned no parseable verdict.' }
    )

    const newStatus = parsed.decision === 'approve' ? 'approved' : 'rejected'
    const notes = String(parsed.notes ?? '').slice(0, 500)
    const conf  = Math.min(Math.max(parsed.confidence ?? 0, 0), 1)

    await this.db.query(
      `UPDATE bounty_picks
         SET status=$1, review_decision=$2, review_notes=$3,
             review_confidence=$4, reviewed_at=NOW(), updated_at=NOW()
       WHERE id=$5`,
      [newStatus, parsed.decision, notes, conf, r.id]
    )

    if (newStatus === 'approved') {
      await this.chat(
        'lila',
        `Approved Scout draft: "${r.draft_title ?? r.title}" — ${reward} on ${r.source}. ${notes}`,
        'status'
      )
    }
    // Rejected drafts stay quiet — Scout files plenty; chat would get spammed.

    return {
      logMessage: `Lila ${newStatus} bounty "${(r.draft_title ?? r.title).slice(0, 60)}" — ${notes.slice(0, 80)}`,
      logType: newStatus === 'approved' ? 'success' : 'info',
      posted: newStatus === 'approved',
    }
  }

  // ── Priority 3: trade cycle ────────────────────────────────────────────────

  private async shouldTrade(): Promise<boolean> {
    const { rows: [s] } = await this.db.query(
      'SELECT last_trade_at FROM management_state WHERE id=1'
    )
    if (!s?.last_trade_at) return true
    return (Date.now() - new Date(s.last_trade_at).getTime()) / 1000 >= cfg.MANAGEMENT_TRADE_SEC
  }

  private async runTradeCycle(): Promise<ManagementResult | null> {
    const hasAlpaca = !!(process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID)

    await this.db.query(
      'UPDATE management_state SET last_trade_at=NOW(), updated_at=NOW() WHERE id=1'
    )

    if (!hasAlpaca) {
      return { logMessage: 'Trade cycle skipped — no Alpaca key.', logType: 'info', posted: false }
    }

    // Gather context
    const { rows: notes } = await this.db.query(
      `SELECT path, content FROM analyst_notes
       WHERE updated_at > NOW() - INTERVAL '24 hours'
       ORDER BY updated_at DESC LIMIT 10`
    )
    const { rows: picks } = await this.db.query(
      `SELECT symbol, confidence, reason FROM analyst_picks
       WHERE status='pending' AND created_at > NOW() - INTERVAL '24 hours'
       ORDER BY confidence DESC LIMIT 10`
    )
    const positions = await Alpaca.getPositions().catch(() => [] as Alpaca.AlpacaPosition[])

    const notesBlob = notes.length
      ? notes.map((n: { path: string; content: string }) => `=== ${n.path} ===\n${n.content.slice(0, 300)}`).join('\n\n')
      : '(none)'
    const picksBlob = picks.length
      ? picks.map((p: { symbol: string; confidence: string; reason: string }) =>
          `${p.symbol} conf=${p.confidence} — ${p.reason}`).join('\n')
      : '(none)'
    const posBlob = positions.length
      ? positions.map(p =>
          `${p.symbol} qty=${p.qty} entry=$${parseFloat(p.avg_entry_price).toFixed(2)} now=$${parseFloat(p.current_price).toFixed(2)} pl=${(parseFloat(p.unrealized_plpc) * 100).toFixed(1)}%`
        ).join('\n')
      : '(flat)'

    const raw = await this.llm(
      'lila.trade',
      TRADE_PLAN_PROMPT
        .replace('{NOTES}', notesBlob)
        .replace('{PICKS}', picksBlob)
        .replace('{POSITIONS}', posBlob),
      700
    )
    const plan = this.parse(raw, {
      stance: 'No change.',
      trades: [] as LilaTrade[],
      positionActions: [] as { symbol: string; action: string; reason: string }[],
    })

    // File plan
    await this.note(
      `lila/plans/${today()}-${Date.now()}.md`,
      `# Lila Plan ${today()}\n\n## Stance\n${plan.stance}\n\n## Trades\n${JSON.stringify(plan.trades ?? [], null, 2)}\n\n## Position actions\n${JSON.stringify(plan.positionActions ?? [], null, 2)}`
    )

    // Queue new trades (TradingEngine will execute during market hours)
    let queued = 0
    for (const t of plan.trades ?? []) {
      if (!t.symbol || !t.entry || !t.stop || !t.target) continue
      if (t.stop >= t.entry) continue
      await this.db.query(
        `INSERT INTO analyst_picks
           (symbol, direction, entry_price, target_price, stop_loss, confidence, risk_level, reason, asset_class, status)
         VALUES ($1,'long',$2,$3,$4,$5,'tight',$6,'lila-plan','pending')`,
        [t.symbol.toUpperCase(), t.entry, t.target, t.stop, Math.min(Math.max(t.confidence ?? 0.6, 0), 1), t.reason ?? 'Lila plan']
      )
      queued++
    }

    // Close positions she wants out
    let closed = 0
    for (const a of plan.positionActions ?? []) {
      if (a.action !== 'CLOSE') continue
      const ok = await Alpaca.closePosition(a.symbol).catch(() => false)
      if (!ok) continue
      const pos = positions.find(p => p.symbol === a.symbol)
      const pnl = pos ? parseFloat(pos.unrealized_pl) : 0
      await this.db.query(
        `UPDATE lila_positions SET status='closed', pnl=$1, closed_at=NOW()
         WHERE symbol=$2 AND status='open'`,
        [pnl, a.symbol]
      )
      // NOTE: do NOT credit lila_state.total_earned. That column is for
      // confirmed bounty payouts only. Trading P&L stays in lila_positions.
      closed++
    }

    const summary = [
      plan.stance.slice(0, 140),
      queued > 0 ? `${queued} new trade${queued === 1 ? '' : 's'} queued.` : null,
      closed > 0 ? `Cut ${closed} position${closed === 1 ? '' : 's'}.` : null,
    ].filter(Boolean).join(' ')

    await this.chat('lila', summary.slice(0, 500), 'status')
    return {
      logMessage: `Lila trade cycle: ${queued} queued, ${closed} closed.`,
      logType: queued + closed > 0 ? 'success' : 'info',
      posted: true,
    }
  }

  // ── Priority 4: proactive check-in ─────────────────────────────────────────

  private async shouldCheckIn(): Promise<boolean> {
    const { rows: [s] } = await this.db.query(
      'SELECT last_check_at FROM management_state WHERE id=1'
    )
    if (!s?.last_check_at) return true
    return (Date.now() - new Date(s.last_check_at).getTime()) / 1000 >= cfg.MANAGEMENT_CHECK_SEC
  }

  private async proactiveCheckIn(): Promise<ManagementResult | null> {
    const { rows: [s] } = await this.db.query(
      'SELECT last_earned FROM management_state WHERE id=1'
    )
    const { rows: [state] } = await this.db.query(
      'SELECT total_earned FROM lila_state WHERE id=1'
    )
    const totalEarned = parseFloat(state?.total_earned ?? '0')
    const lastEarned  = parseFloat(s?.last_earned ?? '0')
    const delta       = totalEarned - lastEarned

    const { rows: errCount } = await this.db.query(
      `SELECT COUNT(*) AS n FROM lila_log
       WHERE type='warn' AND created_at > NOW() - INTERVAL '30 minutes'`
    )
    const errors = Number(errCount[0]?.n ?? 0)

    const { rows: approved } = await this.db.query(
      `SELECT COUNT(*) AS n FROM security_reports WHERE status='approved'`
    )
    const approvedCount = Number(approved[0]?.n ?? 0)

    // Docs KPI flag: after 3+ attempts with zero paid, we want Lila to
    // surface it once (not repeatedly). We stash the flag state on
    // management_state.last_error_cnt... no — that's taken. Use a
    // simple count-based gate: only fire when a NEW unpaid attempt has
    // been added since the last check.
    const { rows: [docs] } = await this.db.query(
      `SELECT
         COUNT(*)                                AS attempts,
         COUNT(*) FILTER (WHERE status='paid')   AS paid
       FROM security_reports WHERE kind='docs'`
    )
    const docsAttempts = Number(docs?.attempts ?? 0)
    const docsPaid     = Number(docs?.paid ?? 0)
    const docsUnderperforming =
      (docsAttempts >= 3 && docsPaid === 0) ||
      (docsAttempts >= 5 && docsPaid / docsAttempts < 0.15)

    // Count reports newly paid this window — that's a REAL win.
    const { rows: paidWindow } = await this.db.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(payout), 0) AS total
       FROM security_reports
       WHERE paid_at IS NOT NULL
         AND paid_at > COALESCE(
           (SELECT last_check_at FROM management_state WHERE id=1),
           NOW() - INTERVAL '1 hour'
         )`
    )
    const paidN = Number(paidWindow[0]?.n ?? 0)
    const paidTotal = parseFloat(paidWindow[0]?.total ?? '0')

    let event: string | null = null
    if (paidN > 0) {
      event = `${paidN} bounty payout${paidN > 1 ? 's' : ''} confirmed: +$${paidTotal.toFixed(2)}. Real money in. Acknowledge.`
    } else if (delta >= BIG_WIN_THRESHOLD) {
      // Trading P&L (position closed at profit) is the only other path that
      // increments total_earned. Report it as trading, not "earnings".
      event = `Trading P&L up $${delta.toFixed(2)} since last check (closed position).`
    } else if (errors >= ERROR_THRESHOLD) {
      event = `${errors} warnings in the last 30 minutes. Cipher may be stuck.`
    } else if (docsUnderperforming) {
      event = `Docs KPI flag: ${docsAttempts} attempts filed, ${docsPaid} paid (ratio ${(docsPaid / Math.max(docsAttempts, 1) * 100).toFixed(0)}%). Per the alternation plan, I should recommend weighting audit over docs until a payout lands. Tell the operator and suggest the call.`
    } else if (approvedCount > 0) {
      event = `${approvedCount} approved report${approvedCount > 1 ? 's' : ''} ready for operator to submit. Still unpaid — not earnings yet.`
    } else if (delta === 0 && totalEarned > 0) {
      const { rows: [last] } = await this.db.query(
        `SELECT last_check_at FROM management_state WHERE id=1`
      )
      const hrs = last?.last_check_at
        ? (Date.now() - new Date(last.last_check_at).getTime()) / 3_600_000
        : Infinity
      if (hrs >= 3) event = 'No new earnings in a while. Probe what is blocking the queue.'
    }

    await this.db.query(
      `UPDATE management_state SET last_check_at=NOW(), last_earned=$1, last_error_cnt=$2, updated_at=NOW() WHERE id=1`,
      [totalEarned, errors]
    )

    if (!event) return { logMessage: 'Nothing notable.', logType: 'info', posted: false }

    // Event-fingerprint dedup: same trigger within the last hour ⇒ skip.
    // Without this, "X approved report ready" / "Y warnings in 30m" /
    // "no new earnings" fire every MANAGEMENT_CHECK_SEC and Lila spams
    // chat with the same observation. Fingerprint is the first 80 chars
    // of the canonical event string (stable across LLM phrasing).
    const fingerprint = event.slice(0, 80)
    const { rows: [prev] } = await this.db.query(
      `SELECT last_proactive_event, last_proactive_at FROM management_state WHERE id=1`
    )
    if (
      prev?.last_proactive_event === fingerprint &&
      prev.last_proactive_at &&
      (Date.now() - new Date(prev.last_proactive_at).getTime()) < 60 * 60 * 1000
    ) {
      return { logMessage: `Check-in dedup: same event as last (${fingerprint.slice(0, 40)})`, logType: 'info', posted: false }
    }

    const context = await this.context(totalEarned)
    const msg = await this.llm(
      'lila.proactive',
      PROACTIVE_PROMPT.replace('{CONTEXT}', context).replace('{EVENT}', event),
      160
    )
    if (!msg) return { logMessage: `Check-in: ${event}`, logType: 'info', posted: false }

    // Final dedup gate: if Lila has already posted a 'message'-kind chat
    // within the last 60 seconds (e.g. desk processor or the streaming
    // /api/chat reply finished after this run started), skip the post
    // rather than stacking another message on top.
    const { rows: recent } = await this.db.query(
      `SELECT 1 FROM chat_messages
       WHERE thread='main' AND sender='lila' AND kind='message'
         AND created_at > NOW() - INTERVAL '60 seconds'
       LIMIT 1`
    )
    if (recent.length > 0) {
      return { logMessage: `Check-in suppressed: lila posted recently`, logType: 'info', posted: false }
    }

    await this.chat('lila', msg.slice(0, 500))
    await this.db.query(
      `UPDATE management_state SET last_proactive_event=$1, last_proactive_at=NOW() WHERE id=1`,
      [fingerprint]
    )
    return { logMessage: `Lila check-in: ${event.slice(0, 80)}`, logType: 'success', posted: true }
  }

  // ── Context builder ────────────────────────────────────────────────────────

  private async context(totalEarnedOverride?: number): Promise<string> {
    const { rows: [ls] } = await this.db.query(
      'SELECT total_earned, active_tasks FROM lila_state WHERE id=1'
    )
    const totalEarned = totalEarnedOverride ?? parseFloat(ls?.total_earned ?? '0')
    const tasks: string[] = ls?.active_tasks ?? []

    const { rows: openPos } = await this.db.query(
      `SELECT symbol FROM lila_positions WHERE status='open' LIMIT 5`
    )
    const { rows: approvedDrafts } = await this.db.query(
      `SELECT title, reward FROM security_reports WHERE status='approved' ORDER BY updated_at DESC LIMIT 3`
    )
    const { rows: reviewQueue } = await this.db.query(
      `SELECT COUNT(*) AS n FROM security_reports WHERE status='pending_review'`
    )
    const pendingCount = Number(reviewQueue[0]?.n ?? 0)
    const { rows: submittedRows } = await this.db.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(reward), 0) AS max_pending
       FROM security_reports WHERE status='submitted'`
    )
    const submittedCount = Number(submittedRows[0]?.n ?? 0)
    const submittedMax = parseFloat(submittedRows[0]?.max_pending ?? '0')
    const { rows: [lastPaid] } = await this.db.query(
      `SELECT title, payout FROM security_reports
       WHERE status='paid' ORDER BY paid_at DESC LIMIT 1`
    )
    const { rows: recentLog } = await this.db.query(
      `SELECT message FROM lila_log ORDER BY id DESC LIMIT 5`
    )

    return [
      `Earned (confirmed paid + closed-trade P&L): $${totalEarned.toFixed(2)}`,
      lastPaid ? `Last payout: ${lastPaid.title} +$${parseFloat(lastPaid.payout ?? '0').toFixed(2)}` : 'No confirmed payouts yet.',
      submittedCount ? `Pending payouts: ${submittedCount} up to $${submittedMax.toFixed(2)} max (NOT yet earned).` : null,
      tasks.length ? `Tasks: ${tasks.slice(0, 3).join(' | ')}` : 'No open tasks.',
      openPos.length ? `Positions: ${openPos.map((p: { symbol: string }) => p.symbol).join(', ')}` : 'Flat.',
      approvedDrafts.length
        ? `Approved reports waiting for operator submit: ${approvedDrafts.map((d: { title: string; reward: string }) => `${d.title} (max $${d.reward})`).join(' | ')}`
        : null,
      pendingCount ? `My review queue: ${pendingCount}` : null,
      `Recent: ${recentLog.map((l: { message: string }) => l.message.slice(0, 70)).join(' · ')}`,
    ].filter(Boolean).join('\n')
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async llm(module: string, prompt: string, maxTokens: number): Promise<string> {
    try {
      const { content } = await llmCall({
        ai: this.ai!,
        module,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.5,
      })
      return content
    } catch (e) {
      if (e instanceof LLMBudgetExceeded) return ''
      return ''
    }
  }

  private parse<T>(raw: string, fallback: T): T {
    try { return JSON.parse(raw) } catch { return fallback }
  }

  private async note(path: string, content: string): Promise<void> {
    await this.db.query(
      `INSERT INTO analyst_notes (path, content, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (path) DO UPDATE SET content=$2, updated_at=NOW()`,
      [path, content]
    )
  }

  // kind:
  //   'message' (default) — true conversational reply, surfaces in Chat tab
  //   'status'            — work update / log; persisted but hidden from Chat
  //   'alert'             — system alert; hidden from Chat (shown elsewhere)
  private async chat(sender: string, content: string, kind: 'message' | 'status' | 'alert' = 'message'): Promise<void> {
    await this.db.query(
      `INSERT INTO chat_messages (sender, content, kind) VALUES ($1,$2,$3)`,
      [sender, content, kind]
    )
  }
}

interface LilaTrade {
  symbol: string
  entry: number
  target: number
  stop: number
  confidence?: number
  reason?: string
}
