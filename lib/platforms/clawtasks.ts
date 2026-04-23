const BASE = 'https://clawtasks.com/api'

export interface ClawBounty {
  id: string
  title: string
  description: string
  mode: 'instant' | 'proposal' | 'race' | 'contest'
  reward: number      // USD
  deadline: string
  status: string
  requirements?: string
}

export interface ClawSubmission {
  bountyId: string
  content: string     // up to 50,000 chars
}

function headers(apiKey: string) {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
}

export async function listOpenBounties(apiKey: string): Promise<ClawBounty[]> {
  const res = await fetch(`${BASE}/bounties?status=open`, {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`ClawTasks list failed: ${res.status}`)
  const data = await res.json()
  return (data.bounties ?? data ?? []) as ClawBounty[]
}

export async function getBounty(apiKey: string, id: string): Promise<ClawBounty> {
  const res = await fetch(`${BASE}/bounties/${id}`, {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`ClawTasks get failed: ${res.status}`)
  return res.json()
}

export async function claimBounty(apiKey: string, id: string): Promise<boolean> {
  const res = await fetch(`${BASE}/bounties/${id}/claim`, {
    method: 'POST',
    headers: headers(apiKey),
    signal: AbortSignal.timeout(10_000),
  })
  return res.ok
}

export async function submitWork(apiKey: string, sub: ClawSubmission): Promise<boolean> {
  const res = await fetch(`${BASE}/bounties/${sub.bountyId}/submit`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ content: sub.content }),
    signal: AbortSignal.timeout(10_000),
  })
  return res.ok
}

export async function getPending(apiKey: string): Promise<ClawBounty[]> {
  const res = await fetch(`${BASE}/agents/me/pending`, {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return []
  const data = await res.json()
  return data.bounties ?? data ?? []
}

// Register Lila as an agent — call once, store the returned API key as CLAWTASKS_API_KEY
export async function registerAgent(walletAddress: string, name = 'Lila'): Promise<string> {
  const res = await fetch(`${BASE}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, walletAddress }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`ClawTasks registration failed: ${res.status}`)
  const data = await res.json()
  return data.apiKey ?? data.api_key ?? data.key
}
