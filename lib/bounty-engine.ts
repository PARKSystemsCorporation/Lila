import OpenAI from 'openai'
import * as ClawTasks from './platforms/clawtasks'
import * as Rose from './platforms/rose'

export type Platform = 'clawtasks' | 'rose'

export interface UnifiedBounty {
  platform: Platform
  id: string
  title: string
  description: string
  reward: number        // USD
  canComplete: boolean
  confidence: number    // 0–1
  rawScore: number      // reward * confidence
}

export interface EngineResult {
  action: 'claimed' | 'submitted' | 'idle' | 'error'
  platform?: Platform
  bountyId?: string
  title?: string
  reward?: number
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

Tasks you CAN do: writing, research, code review, documentation, smart contract analysis, bug reports, data analysis, content creation, technical explanations.
Tasks you CANNOT do: tasks requiring a GitHub account login, tasks requiring OAuth/KYC, tasks requiring running code locally, tasks requiring video/audio/images you'd generate.`

const WORK_PROMPT = `You are Lila, an autonomous AI agent completing a paid bounty. Do the work completely and professionally. This is a real submission that will be reviewed and paid.

Be thorough. Cover every requirement stated. Provide actual deliverable output — not an outline, not a plan, but the real thing.

Bounty title: {TITLE}
Requirements: {DESCRIPTION}

Deliver the complete work now. No preamble. No "here is my submission." Just the work.`

export class BountyEngine {
  private ai: OpenAI
  private clawKey?: string
  private roseKey?: string

  constructor(clawKey?: string, roseKey?: string) {
    this.ai = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY!,
      baseURL: 'https://api.deepseek.com/v1',
    })
    this.clawKey = clawKey
    this.roseKey = roseKey
  }

  // ── Fetch bounties from all configured platforms ─────────────────────────

  async fetchAll(): Promise<UnifiedBounty[]> {
    const results: UnifiedBounty[] = []
    const fetches: Promise<void>[] = []

    if (this.clawKey) {
      fetches.push(
        ClawTasks.listOpenBounties(this.clawKey)
          .then(bounties => {
            for (const b of bounties.slice(0, 10)) {
              results.push({
                platform: 'clawtasks',
                id: b.id,
                title: b.title,
                description: b.description,
                reward: b.reward ?? 0,
                canComplete: false,
                confidence: 0,
                rawScore: 0,
              })
            }
          })
          .catch(() => {}) // platform down — keep going
      )
    }

    if (this.roseKey) {
      fetches.push(
        Rose.listOpenTasks(this.roseKey)
          .then(tasks => {
            for (const t of tasks.slice(0, 10)) {
              results.push({
                platform: 'rose',
                id: t.id,
                title: t.title,
                description: t.description,
                reward: t.rewardUsd ?? t.reward ?? 0,
                canComplete: false,
                confidence: 0,
                rawScore: 0,
              })
            }
          })
          .catch(() => {})
      )
    }

    await Promise.all(fetches)
    return results
  }

  // ── Score each bounty with DeepSeek ──────────────────────────────────────

  async scoreBounties(bounties: UnifiedBounty[]): Promise<UnifiedBounty[]> {
    // Score up to 5 bounties in parallel to stay within rate limits
    const toScore = bounties.slice(0, 5)
    const scored = await Promise.all(
      toScore.map(async b => {
        try {
          const res = await this.ai.chat.completions.create({
            model: 'deepseek-chat',
            messages: [
              { role: 'system', content: SCORE_PROMPT },
              { role: 'user', content: `Title: ${b.title}\n\nDescription: ${b.description}` },
            ],
            max_tokens: 100,
            temperature: 0.2,
          })
          const raw = res.choices[0]?.message?.content?.trim() ?? '{}'
          const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
          const score = JSON.parse(json)
          return {
            ...b,
            canComplete: !!score.canComplete,
            confidence: Number(score.confidence) || 0,
            rawScore: (b.reward || 1) * (Number(score.confidence) || 0),
          }
        } catch {
          return b
        }
      })
    )
    return scored.sort((a, b) => b.rawScore - a.rawScore)
  }

  // ── Actually do the work ──────────────────────────────────────────────────

  async executeWork(bounty: UnifiedBounty): Promise<string> {
    const prompt = WORK_PROMPT
      .replace('{TITLE}', bounty.title)
      .replace('{DESCRIPTION}', bounty.description.slice(0, 3000))

    const res = await this.ai.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
      temperature: 0.7,
    })
    return res.choices[0]?.message?.content?.trim() ?? ''
  }

  // ── Main tick — find, claim, do, submit ───────────────────────────────────

  async tick(): Promise<EngineResult> {
    if (!this.clawKey && !this.roseKey) {
      return {
        action: 'idle',
        logMessage: 'No platform API keys configured. Set CLAWTASKS_API_KEY or ROSE_API_KEY.',
        logType: 'warn',
      }
    }

    // 1. Fetch all available bounties
    let bounties: UnifiedBounty[]
    try {
      bounties = await this.fetchAll()
    } catch {
      return { action: 'error', logMessage: 'Platform fetch failed. Retrying next tick.', logType: 'warn' }
    }

    if (bounties.length === 0) {
      return { action: 'idle', logMessage: 'Scanned all boards. No open bounties right now.', logType: 'info' }
    }

    // 2. Score with DeepSeek
    const scored = await this.scoreBounties(bounties)
    const best = scored.find(b => b.canComplete && b.confidence > 0.6)

    if (!best) {
      return {
        action: 'idle',
        logMessage: `Reviewed ${scored.length} bounties across platforms. None within capability threshold.`,
        logType: 'info',
      }
    }

    // 3. Claim it
    let claimed = false
    try {
      if (best.platform === 'clawtasks' && this.clawKey) {
        claimed = await ClawTasks.claimBounty(this.clawKey, best.id)
      } else if (best.platform === 'rose' && this.roseKey) {
        claimed = await Rose.claimTask(this.roseKey, best.id)
      }
    } catch {
      return { action: 'error', logMessage: `Claim failed for "${best.title}". Moving on.`, logType: 'warn' }
    }

    if (!claimed) {
      return {
        action: 'idle',
        logMessage: `Bounty "${best.title}" already taken. Rescanning.`,
        logType: 'info',
      }
    }

    // 4. Do the work
    let work: string
    try {
      work = await this.executeWork(best)
    } catch {
      return { action: 'error', logMessage: `Work generation failed for "${best.title}".`, logType: 'warn' }
    }

    // 5. Submit
    let submitted = false
    try {
      if (best.platform === 'clawtasks' && this.clawKey) {
        submitted = await ClawTasks.submitWork(this.clawKey, { bountyId: best.id, content: work })
      } else if (best.platform === 'rose' && this.roseKey) {
        submitted = await Rose.submitWork(this.roseKey, { taskId: best.id, content: work })
      }
    } catch {
      submitted = false
    }

    const platform = best.platform === 'clawtasks' ? 'ClawTasks' : 'Rose'
    if (submitted) {
      return {
        action: 'submitted',
        platform: best.platform,
        bountyId: best.id,
        title: best.title,
        reward: best.reward,
        logMessage: `Submitted: "${best.title}" on ${platform}. Payout pending: $${best.reward.toFixed(0)} → ${WALLET.slice(0, 8)}...`,
        logType: 'success',
      }
    }

    return {
      action: 'error',
      logMessage: `Work complete but submission failed on ${platform}. Will retry.`,
      logType: 'warn',
    }
  }
}
