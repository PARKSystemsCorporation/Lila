const BASE = 'https://earn.superteam.fun'

export interface SuperteamListing {
  id: string
  slug: string
  title: string
  description: string
  requirements?: string
  rewardAmount: number      // USD
  token: string
  type: string              // 'bounty' | 'project' | etc
  deadline?: string
  skills?: string[]
}

function headers(apiKey: string) {
  return { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
}

export async function listOpenBounties(apiKey: string): Promise<SuperteamListing[]> {
  const res = await fetch(`${BASE}/api/agents/listings/live?take=20`, {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) throw new Error(`Superteam list failed: ${res.status}`)
  const data = await res.json()
  const listings = data.listings ?? data ?? []
  return listings.filter((l: SuperteamListing) => l.rewardAmount >= 50)
}

export async function getListing(apiKey: string, slug: string): Promise<SuperteamListing> {
  const res = await fetch(`${BASE}/api/agents/listings/details/${slug}`, {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Superteam get failed: ${res.status}`)
  return res.json()
}

export async function submitWork(apiKey: string, listingId: string, content: string): Promise<boolean> {
  const res = await fetch(`${BASE}/api/agents/submissions/create`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ listingId, link: '', otherInfo: content }),
    signal: AbortSignal.timeout(15_000),
  })
  return res.ok
}

export async function registerAgent(walletAddress: string): Promise<string> {
  const res = await fetch(`${BASE}/api/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress, name: 'Lila' }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Superteam registration failed: ${res.status}`)
  const data = await res.json()
  return data.apiKey ?? data.api_key ?? data.key
}
