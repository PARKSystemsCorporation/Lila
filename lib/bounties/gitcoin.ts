// Gitcoin bounties source. Free, no auth required for the public bounties
// list. Endpoint shape (as of 2025/2026):
//   https://gitcoin.co/api/v1/bounties/?bounty_owner_address=&order_by=-web3_created
//     &experience_level=Beginner,Intermediate
//     &project_length=Hours,Days
//     &network=mainnet&idx_status=open
// Returns JSON array. Fields we care about:
//   pk, github_url, title, issue_description, value_in_usdt, value_in_token,
//   token_name, project_type, experience_level, bounty_categories[]
//
// We only pull bounties with: idx_status=open, value_in_usdt ≤ 500,
// project_length in {Hours, Days}, primary language we can handle.

const ENDPOINT = 'https://gitcoin.co/api/v1/bounties/'

export interface GitcoinPick {
  external_id: string
  url: string
  title: string
  summary: string | null
  payout_usd: number | null
  payout_token: string | null
  payout_token_amount: number | null
  repo_url: string | null
  issue_number: number | null
  issue_body: string | null
  language: string | null
  labels: string[]
  difficulty: 'beginner' | 'intermediate' | 'advanced' | null
}

interface GitcoinRaw {
  pk?: number | string
  url?: string
  github_url?: string
  title?: string
  issue_description?: string
  value_in_usdt?: string | number | null
  value_in_token?: string | number | null
  token_name?: string | null
  experience_level?: string | null
  project_type?: string | null
  bounty_categories?: string[]
  metadata?: { issueKeywords?: string[] } & Record<string, unknown>
}

export async function fetchOpenBounties(maxUsd = 500): Promise<GitcoinPick[]> {
  const params = new URLSearchParams({
    idx_status: 'open',
    order_by: '-web3_created',
    project_length: 'Hours,Days',
    network: 'mainnet',
  })
  let raw: GitcoinRaw[]
  try {
    const res = await fetch(`${ENDPOINT}?${params}`, {
      headers: { 'user-agent': 'Lila/Scout (bounty pipeline)' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return []
    const json = await res.json()
    raw = Array.isArray(json) ? json : (Array.isArray(json?.results) ? json.results : [])
  } catch {
    return []
  }

  const out: GitcoinPick[] = []
  for (const b of raw) {
    if (!b?.pk || !b?.github_url || !b?.title) continue
    const usd = b.value_in_usdt != null ? parseFloat(String(b.value_in_usdt)) : null
    if (usd != null && usd > maxUsd) continue
    const { repoUrl, issueNumber } = parseGithubUrl(b.github_url)
    if (!repoUrl) continue   // no parseable repo, can't auto-submit
    out.push({
      external_id: String(b.pk),
      url: b.url ?? b.github_url,
      title: String(b.title).slice(0, 280),
      summary: snippet(b.issue_description, 280),
      payout_usd: usd,
      payout_token: b.token_name ?? null,
      payout_token_amount: b.value_in_token != null ? parseFloat(String(b.value_in_token)) : null,
      repo_url: repoUrl,
      issue_number: issueNumber,
      issue_body: b.issue_description ?? null,
      language: null,
      labels: Array.isArray(b.bounty_categories) ? b.bounty_categories.slice(0, 12) : [],
      difficulty: normalizeDifficulty(b.experience_level),
    })
  }
  return out
}

// ── helpers ──────────────────────────────────────────────────────────────

function parseGithubUrl(url: string): { repoUrl: string | null; issueNumber: number | null } {
  // Accepts "https://github.com/<owner>/<repo>/issues/<n>" + similar.
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/)
  if (m) return { repoUrl: `https://github.com/${m[1]}/${m[2]}`, issueNumber: parseInt(m[3], 10) }
  // No issue, just a repo URL.
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
  if (v.startsWith('begin'))  return 'beginner'
  if (v.startsWith('inter'))  return 'intermediate'
  if (v.startsWith('adv'))    return 'advanced'
  return null
}
