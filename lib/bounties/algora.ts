// Algora bounties source. Public endpoint, no auth needed.
//   https://console.algora.io/api/bounties?status=open&limit=100
// Some Algora orgs proxy through:
//   https://console.algora.io/api/v1/bounties
// Each bounty has: id, task.title, task.body, task.url (GitHub issue),
// reward.amount (in cents), reward.currency, reward_type ('cash' | 'tip').
//
// Only pulls cash bounties ≤ $500 with a github issue link, since the
// PR submission worker is GitHub-based.

import type { GitcoinPick } from './gitcoin'

const ENDPOINTS = [
  // Newer endpoint (preferred)
  'https://console.algora.io/api/v1/bounties?status=open&limit=100',
  // Legacy fallback
  'https://console.algora.io/api/bounties?status=open&limit=100',
]

interface AlgoraRaw {
  id?: string
  status?: string
  reward_type?: string
  reward?: {
    amount?: number              // cents
    currency?: string            // 'USD' typically
  }
  task?: {
    title?: string
    body?: string
    url?: string
    repo_owner?: string
    repo_name?: string
    number?: number
    labels?: string[]
    language?: string | null
  }
  difficulty?: string | null
}

export async function fetchOpenBounties(maxUsd = 500): Promise<GitcoinPick[]> {
  let raw: AlgoraRaw[] = []
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'Lila/Scout (bounty pipeline)' },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) continue
      const json = await res.json()
      const items = Array.isArray(json) ? json
                  : Array.isArray(json?.bounties) ? json.bounties
                  : Array.isArray(json?.data) ? json.data
                  : []
      raw = items as AlgoraRaw[]
      if (raw.length > 0) break
    } catch { /* try next */ }
  }

  const out: GitcoinPick[] = []
  for (const b of raw) {
    if (b.status && b.status !== 'open') continue
    if (b.reward_type && b.reward_type !== 'cash' && b.reward_type !== 'bounty') continue
    if (!b.id || !b.task?.title) continue

    const cents = b.reward?.amount ?? 0
    const usd = cents > 0 ? cents / 100 : null
    if (usd != null && usd > maxUsd) continue

    const taskUrl = b.task.url ?? null
    const { repoUrl, issueNumber } = parseGithubUrl(taskUrl)
    if (!repoUrl) continue

    out.push({
      external_id: String(b.id),
      url: taskUrl ?? `https://console.algora.io/bounties/${b.id}`,
      title: String(b.task.title).slice(0, 280),
      summary: snippet(b.task.body, 280),
      payout_usd: usd,
      payout_token: (b.reward?.currency ?? null),
      payout_token_amount: usd,
      repo_url: repoUrl,
      issue_number: issueNumber ?? b.task.number ?? null,
      issue_body: b.task.body ?? null,
      language: b.task.language ?? null,
      labels: Array.isArray(b.task.labels) ? b.task.labels.slice(0, 12) : [],
      difficulty: normalizeDifficulty(b.difficulty),
    })
  }
  return out
}

function parseGithubUrl(url: string | null | undefined): { repoUrl: string | null; issueNumber: number | null } {
  if (!url) return { repoUrl: null, issueNumber: null }
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/)
  if (m) return { repoUrl: `https://github.com/${m[1]}/${m[2]}`, issueNumber: parseInt(m[3], 10) }
  const r = url.match(/github\.com\/([^/]+)\/([^/]+)/)
  if (r) return { repoUrl: `https://github.com/${r[1]}/${r[2]}`, issueNumber: null }
  return { repoUrl: null, issueNumber: null }
}

function snippet(s: string | undefined | null, max: number): string | null {
  if (!s) return null
  return s.replace(/\s+/g, ' ').trim().slice(0, max)
}

function normalizeDifficulty(level: string | null | undefined): 'beginner' | 'intermediate' | 'advanced' | null {
  const v = String(level ?? '').toLowerCase().trim()
  if (v.startsWith('begin') || v === 'easy')   return 'beginner'
  if (v.startsWith('inter') || v === 'medium') return 'intermediate'
  if (v.startsWith('adv')   || v === 'hard')   return 'advanced'
  return null
}
