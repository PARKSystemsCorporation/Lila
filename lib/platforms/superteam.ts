const BASE = 'https://earn.superteam.fun'

export interface SuperteamListing {
  id: string
  slug: string
  title: string
  description: string
  requirements?: string
  rewardAmount: number      // USD
  token: string
  type: string              // 'bounty' | 'project' | 'hackathon'
  deadline?: string
  skills?: string[]
  compensationType?: string // 'fixed' | 'range' | 'variable'
  pocId?: string
  eligibilityQuestions?: { question: string }[]
}

function headers(apiKey: string) {
  return { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
}

// ── Register ───────────────────────────────────────────────────────────────

export interface RegisterResult {
  apiKey: string
  claimCode: string
  agentId: string
  username: string
}

export async function registerAgent(name = 'lila-agent'): Promise<RegisterResult> {
  const res = await fetch(`${BASE}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Superteam registration failed: ${res.status} ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  if (!data?.apiKey || !data?.claimCode) {
    throw new Error(`Superteam returned unexpected response: ${JSON.stringify(data).slice(0, 200)}`)
  }
  return data
}

// ── Status ─────────────────────────────────────────────────────────────────
// Verify that an agent the caller holds credentials for is still reachable and
// active. Lets the UI distinguish "link 404's because the agent is broken"
// from "link 404's because it was already claimed".

export interface AgentStatus {
  agentId?: string
  username?: string
  status?: string
  claimed?: boolean
  [key: string]: unknown
}

export async function getStatus(apiKey: string): Promise<AgentStatus> {
  const res = await fetch(`${BASE}/api/agents/status`, {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw new Error(`Superteam status failed: ${res.status}`)
  }
  return res.json()
}

// ── Listings ───────────────────────────────────────────────────────────────

export async function listOpenBounties(apiKey: string): Promise<SuperteamListing[]> {
  const deadline = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10) // 90 days out
  const res = await fetch(`${BASE}/api/agents/listings/live?take=30&deadline=${deadline}`, {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) throw new Error(`Superteam list failed: ${res.status}`)
  const data = await res.json()
  const listings: SuperteamListing[] = data.listings ?? data ?? []
  return listings.filter(l => l.rewardAmount >= 50)
}

export async function getListing(apiKey: string, slug: string): Promise<SuperteamListing> {
  const res = await fetch(`${BASE}/api/agents/listings/details/${slug}`, {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Superteam get listing failed: ${res.status}`)
  return res.json()
}

// ── Submit ─────────────────────────────────────────────────────────────────

export interface SubmitOptions {
  listingId: string
  content: string                                    // goes into otherInfo
  link?: string
  eligibilityAnswers?: { question: string; answer: string }[]
  ask?: number | null
}

export async function submitWork(apiKey: string, opts: SubmitOptions): Promise<boolean> {
  const body: Record<string, unknown> = {
    listingId: opts.listingId,
    link: opts.link ?? '',
    tweet: '',
    otherInfo: opts.content,
    eligibilityAnswers: opts.eligibilityAnswers ?? [],
    ask: opts.ask ?? null,
  }

  const res = await fetch(`${BASE}/api/agents/submissions/create`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  return res.ok
}

export async function updateSubmission(apiKey: string, opts: SubmitOptions): Promise<boolean> {
  const body: Record<string, unknown> = {
    listingId: opts.listingId,
    link: opts.link ?? '',
    tweet: '',
    otherInfo: opts.content,
    eligibilityAnswers: opts.eligibilityAnswers ?? [],
    ask: opts.ask ?? null,
  }

  const res = await fetch(`${BASE}/api/agents/submissions/update`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  return res.ok
}
