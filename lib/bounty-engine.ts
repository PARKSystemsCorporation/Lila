import OpenAI from 'openai'
import * as ClawTasks from './platforms/clawtasks'
import * as Superteam from './platforms/superteam'

import type { UnifiedBounty } from '@/app/api/bounties/route'

export type { UnifiedBounty }

export interface EngineResult {
  action: 'claimed' | 'submitted' | 'idle' | 'error'
  bountyId?: string
  title?: string
  reward?: number
  platform?: string
  logMessage: string
  logType: 'info' | 'success' | 'warn'
}

const WALLET = '0x3a6Dd93f29041aDC2ffB142EdC98434c60110926'

const SCORE_PROMPT = `You are Lila's task evaluation module. Given a bounty, decide if you can complete it autonomously using only text generation, research, code writing, or analysis.

Respond with ONLY valid JSON:
{
  "canComplete": true/false,
  "confidence": 0.0–1.0,
  "reason": "one sentence"
}

Tasks you CAN do: writing, research, code review, documentation, smart contract analysis, bug reports, data analysis, content creation, technical explanations, proposals.
Tasks you CANNOT do: tasks requiring GitHub OAuth login, KYC, running code locally, video/audio/image generation, on-chain transactions.`

const WORK_PROMPT = `You are Lila, an autonomous AI agent completing a paid bounty. This is a real submission that will be reviewed. Do the work completely and professionally.

Be thorough. Cover every requirement. Deliver actual output — not an outline, the real thing.

Bounty: {TITLE}
Requirements: {DESCRIPTION}

Deliver the complete work now. No preamble.`

export class BountyEngine {
  private ai: OpenAI

  constructor() {
    this.ai = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY!,
      baseURL: 'https://api.deepseek.com/v1',
    })
  }

  // ── Score a list of bounties with DeepSeek ─────────────────────────────

  async scoreBounties(bounties: UnifiedBounty[]): Promise<(UnifiedBounty & { confidence: number; rawScore: number })[]> {
    const candidates = bounties.filter(b => !b.readOnly && b.reward >= 50).slice(0, 6)

    const scored = await Promise.all(candidates.map(async b => {
      try {
        const res = await this.ai.chat.completions.create({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: SCORE_PROMPT },
            { role: 'user', content: `Title: ${b.title}\n\nDescription: ${b.description.slice(0, 800)}` },
          ],
          max_tokens: 100,
          temperature: 0.2,
        })
        const raw = (res.choices[0]?.message?.content ?? '{}')
          .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
        const score = JSON.parse(raw)
        const confidence = Number(score.canComplete ? score.confidence : 0) || 0
        return { ...b, confidence, rawScore: b.reward * confidence }
      } catch {
        return { ...b, confidence: 0, rawScore: 0 }
      }
    }))

    return scored.sort((a, b) => b.rawScore - a.rawScore)
  }

  // ── Generate real work output ──────────────────────────────────────────

  async executeWork(bounty: UnifiedBounty): Promise<string> {
    const res = await this.ai.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{
        role: 'user',
        content: WORK_PROMPT
          .replace('{TITLE}', bounty.title)
          .replace('{DESCRIPTION}', bounty.description.slice(0, 3000)),
      }],
      max_tokens: 2000,
      temperature: 0.7,
    })
    return res.choices[0]?.message?.content?.trim() ?? ''
  }

  // ── Claim + submit on the correct platform ─────────────────────────────

  async claimAndSubmit(bounty: UnifiedBounty, work: string): Promise<boolean> {
    const rawId = bounty.id.replace(/^(st|bc|ct|imf)_/, '')

    if (bounty.platform === 'clawtasks' && process.env.CLAWTASKS_API_KEY) {
      const claimed = await ClawTasks.claimBounty(process.env.CLAWTASKS_API_KEY, rawId)
      if (!claimed) return false
      return ClawTasks.submitWork(process.env.CLAWTASKS_API_KEY, { bountyId: rawId, content: work })
    }

    if (bounty.platform === 'superteam' && process.env.SUPERTEAM_API_KEY) {
      // Superteam: submit directly (no separate claim step)
      return Superteam.submitWork(process.env.SUPERTEAM_API_KEY, rawId, work)
    }

    // Bountycaster: no programmatic claim API — log for operator to submit manually
    if (bounty.platform === 'bountycaster') {
      return true  // work is done; operator submits via Warpcast
    }

    return false
  }

  // ── Main tick ──────────────────────────────────────────────────────────

  async tick(assignedBounty: UnifiedBounty | null, liveBounties: UnifiedBounty[]): Promise<EngineResult> {
    // If operator assigned a specific task, work on that first
    const workQueue = assignedBounty
      ? [assignedBounty, ...liveBounties.filter(b => b.id !== assignedBounty.id)]
      : liveBounties

    const actionable = workQueue.filter(b => !b.readOnly && b.reward >= 50)

    if (actionable.length === 0) {
      return { action: 'idle', logMessage: 'Scanned all boards. No qualifying paid tasks right now.', logType: 'info' }
    }

    // Score candidates (operator-assigned gets priority boost)
    const scored = await this.scoreBounties(actionable)
    const best = assignedBounty && scored.find(b => b.id === assignedBounty.id && b.confidence > 0.4)
      ?? scored.find(b => b.confidence > 0.6)

    if (!best) {
      return {
        action: 'idle',
        logMessage: `Reviewed ${scored.length} bounties. None above confidence threshold. Waiting.`,
        logType: 'info',
      }
    }

    // Execute the work
    let work: string
    try {
      work = await this.executeWork(best)
    } catch {
      return { action: 'error', logMessage: `Work generation failed for "${best.title}".`, logType: 'warn' }
    }

    // Submit
    const submitted = await this.claimAndSubmit(best, work).catch(() => false)

    const chain = best.chain === 'Solana' ? '(you cash out)' : `→ ${WALLET.slice(0, 10)}...`

    if (submitted) {
      const manualNote = best.platform === 'bountycaster' ? ' Work ready — submit via Warpcast.' : ''
      return {
        action: 'submitted',
        bountyId: best.id,
        title: best.title,
        reward: best.reward,
        platform: best.platformLabel,
        logMessage: `Submitted: "${best.title}" on ${best.platformLabel}. $${best.reward} pending ${chain}.${manualNote}`,
        logType: 'success',
      }
    }

    return { action: 'error', logMessage: `Submission failed on ${best.platformLabel}. Will retry.`, logType: 'warn' }
  }
}
