// Immunefi public API — no auth required
// Read-only: surfaces high-value security programs so user can see opportunities
// Lila doesn't auto-submit here (security research requires domain expertise)

const ENDPOINT = 'https://immunefi.com/public-api/bounties.json'

export interface ImmunefiProgram {
  id: string
  title: string
  slug: string
  maxBounty: number       // USD
  rewardsToken: string
  kyc: boolean
  inviteOnly: boolean
  assets: string[]
  url: string
}

interface RawProgram {
  id?: string
  project?: string
  name?: string
  slug?: string
  maxBounty?: number
  rewardsToken?: string
  KYCRequired?: boolean
  inviteOnly?: boolean
  assets?: unknown[]
}

export async function listPrograms(): Promise<ImmunefiProgram[]> {
  // The endpoint returns ~9MB — past Next.js's 2MB data-cache cap. Using
  // `next: { revalidate }` would emit a warning every call and never
  // actually cache. `no-store` is explicit and silent; downstream callers
  // should add their own short-TTL memo if they want caching.
  const res = await fetch(ENDPOINT, {
    signal: AbortSignal.timeout(15_000),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Immunefi fetch failed: ${res.status}`)

  const data: RawProgram[] = await res.json()

  return data
    .filter(p => !p.inviteOnly && (p.maxBounty ?? 0) >= 50_000)
    .map(p => ({
      id: String(p.id ?? p.slug ?? p.project),
      title: p.project ?? p.name ?? 'Unknown',
      slug: p.slug ?? '',
      maxBounty: p.maxBounty ?? 0,
      rewardsToken: p.rewardsToken ?? 'USDC',
      kyc: p.KYCRequired ?? false,
      inviteOnly: p.inviteOnly ?? false,
      assets: Array.isArray(p.assets) ? p.assets.map(String) : [],
      url: `https://immunefi.com/bug-bounty/${p.slug}/`,
    }))
    .sort((a, b) => b.maxBounty - a.maxBounty)
    .slice(0, 20)
}
