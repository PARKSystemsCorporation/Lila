// GitHub search for new Solidity repos. No token = 60 req/hr rate limit,
// which is plenty given we run the discovery pass once per day.
// Optionally set GITHUB_TOKEN for a 5000 req/hr allowance.

export interface NormalizedGitHub {
  externalId: string    // full_name, e.g. "owner/repo"
  name: string
  url: string
  stars: number
  listedAt: Date
  scope: string
}

interface GitHubSearchRepo {
  full_name: string
  name: string
  html_url: string
  description: string | null
  stargazers_count: number
  forks_count: number
  pushed_at: string
  created_at: string
  language: string | null
  topics: string[]
}

interface GitHubSearchResponse {
  total_count: number
  items: GitHubSearchRepo[]
}

function headers() {
  const h: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (process.env.GITHUB_TOKEN) h['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`
  return h
}

// Young Solidity repos pushed recently. Small-star threshold so we're
// catching early stuff, not well-known projects.
export async function discoverNew(opts: {
  maxAgeDays?: number
  maxStars?: number
  limit?: number
} = {}): Promise<NormalizedGitHub[]> {
  const maxAgeDays = opts.maxAgeDays ?? 90
  const maxStars   = opts.maxStars   ?? 50
  const limit      = opts.limit      ?? 30

  const created = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString().slice(0, 10)
  const pushed  = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10)

  const q = `language:solidity created:>${created} pushed:>${pushed} stars:<${maxStars}`
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${Math.min(limit, 50)}`

  let data: GitHubSearchResponse
  try {
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return []
    data = await res.json()
  } catch {
    return []
  }

  return (data.items ?? []).map(r => ({
    externalId: r.full_name,
    name: r.full_name,
    url: r.html_url,
    stars: r.stargazers_count,
    listedAt: new Date(r.created_at),
    scope: [
      r.description ? r.description.slice(0, 400) : null,
      r.topics?.length ? `Topics: ${r.topics.slice(0, 5).join(', ')}` : null,
      `Stars: ${r.stargazers_count} · Forks: ${r.forks_count}`,
      `Pushed: ${r.pushed_at.slice(0, 10)} · Created: ${r.created_at.slice(0, 10)}`,
    ].filter(Boolean).join('\n'),
  }))
}
