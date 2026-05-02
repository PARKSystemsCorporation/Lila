// Shared helpers for any agent that drafts a GitHub PR from a bounty row:
// repo-tree fetch, JSON parsing, confidence clamping, body truncation. Both
// Scout and Forge use these — keep them here so the two loops stay thin.

export const REPO_TREE_CAP = 60   // file paths included in prompt

export function clamp01(n: unknown): number | null {
  if (n == null || !Number.isFinite(n as number)) return null
  const v = Number(n)
  if (v < 0) return 0
  if (v > 1) return 1
  return +v.toFixed(2)
}

export function safeParse<T>(s: string, fallback: T): T {
  const cleaned = s.replace(/```json|```/g, '').trim()
  try { return JSON.parse(cleaned) as T } catch { return fallback }
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '\n\n[…truncated]'
}

// Best-effort GitHub repo tree fetch. Public repos work unauth'd at 60
// req/hr; with GITHUB_TOKEN we get 5000 req/hr. Returns up to a few
// hundred file paths (capped by the API). Empty array on any error.
export async function fetchRepoTree(repoUrl: string | null, agent = 'Lila/Bot'): Promise<string[]> {
  if (!repoUrl) return []
  const m = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/)
  if (!m) return []
  const owner = m[1]
  const repo  = m[2].replace(/\.git$/, '')

  const headers: Record<string, string> = {
    'accept': 'application/vnd.github+json',
    'user-agent': agent,
  }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`

  try {
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers, signal: AbortSignal.timeout(10_000),
    })
    if (!repoRes.ok) return []
    const repoJson = await repoRes.json() as { default_branch?: string }
    const branch = repoJson.default_branch ?? 'main'

    const treeRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
      { headers, signal: AbortSignal.timeout(15_000) }
    )
    if (!treeRes.ok) return []
    const treeJson = await treeRes.json() as { tree?: { path?: string; type?: string }[] }
    const paths = (treeJson.tree ?? [])
      .filter(t => t.type === 'blob' && typeof t.path === 'string')
      .map(t => t.path as string)
      .filter(p => !p.startsWith('node_modules/'))
      .filter(p => !p.startsWith('vendor/'))
      .filter(p => !p.startsWith('dist/'))
      .filter(p => !p.startsWith('build/'))
      .filter(p => !p.endsWith('.lock'))
      .filter(p => !p.endsWith('.min.js'))
    return paths
  } catch {
    return []
  }
}

export interface DraftResponse {
  draft_title?: string
  draft_body?: string
  draft_diff?: string
  files_touched?: string[]
  confidence?: number
}

export interface DiscoveredRow {
  id: number
  source: string
  external_id: string
  url: string
  title: string
  summary: string | null
  payout_usd: string | null
  payout_token: string | null
  repo_url: string | null
  issue_number: number | null
  issue_body: string | null
  language: string | null
  labels: string[] | null
  difficulty: string | null
}
