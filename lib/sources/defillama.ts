// DefiLlama protocol list. No API key needed.
// Returns a big JSON array; we filter to young + small = least-audited.

export interface LlamaProtocol {
  id: string
  name: string
  symbol?: string
  slug: string
  url?: string
  description?: string
  chain?: string
  category?: string
  tvl?: number
  listedAt?: number     // unix seconds, sometimes null
  audit_links?: string[]
  audit?: string
}

export interface NormalizedLlama {
  externalId: string    // slug
  name: string
  url?: string
  chain?: string
  tvl?: number
  listedAt?: Date
  scope?: string
}

// Raw fetch — returns the full DefiLlama protocol array.
async function fetchProtocols(): Promise<LlamaProtocol[]> {
  const res = await fetch('https://api.llama.fi/protocols', {
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`DefiLlama ${res.status}`)
  return res.json()
}

// Pick candidates: listed in the last 90 days, TVL < $10M, no visible audit
// links. That's the "young + small + under-audited" signal.
export async function discoverNew(opts: {
  maxAgeDays?: number
  maxTvl?: number
  limit?: number
} = {}): Promise<NormalizedLlama[]> {
  const maxAgeDays = opts.maxAgeDays ?? 90
  const maxTvl     = opts.maxTvl     ?? 10_000_000
  const limit      = opts.limit      ?? 40

  const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86_400

  let all: LlamaProtocol[] = []
  try {
    all = await fetchProtocols()
  } catch {
    return []
  }

  const filtered = all
    .filter(p => typeof p.listedAt === 'number' && p.listedAt >= cutoff)
    .filter(p => (p.tvl ?? Infinity) < maxTvl)
    .filter(p => {
      const hasAudit = (p.audit_links && p.audit_links.length > 0) || (p.audit && p.audit !== '0')
      return !hasAudit
    })
    .sort((a, b) => (b.listedAt ?? 0) - (a.listedAt ?? 0))
    .slice(0, limit)

  return filtered.map(p => ({
    externalId: p.slug,
    name: p.name,
    url: p.url,
    chain: p.chain,
    tvl: p.tvl,
    listedAt: p.listedAt ? new Date(p.listedAt * 1000) : undefined,
    scope: [
      p.category ? `Category: ${p.category}` : null,
      p.chain ? `Chain: ${p.chain}` : null,
      p.tvl != null ? `TVL: $${p.tvl.toLocaleString()}` : null,
      p.description ? `\n${p.description.slice(0, 600)}` : null,
    ].filter(Boolean).join(' · '),
  }))
}
