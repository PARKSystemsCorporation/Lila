// Bountycaster bounties live on Farcaster — accessed via Neynar API
// @bountybot posts casts when bounties open; we parse them for amount + description

const NEYNAR = 'https://api.neynar.com/v2'
const BOUNTYBOT_CHANNEL = 'bountycaster'

// Patterns to extract USD/token amounts from cast text
const AMOUNT_RE = /\$([0-9,]+(?:\.[0-9]+)?)\s*(?:USDC|USD|ETH|OP|DEGEN)?/i
const CLAIMED_RE = /\b(claimed|cancelled|closed|filled)\b/i

export interface BountycasterBounty {
  id: string          // cast hash
  title: string
  description: string
  reward: number      // USD approximation
  token: string
  castUrl: string
  authorFid: number
  timestamp: string
}

function headers(apiKey: string) {
  return { 'api_key': apiKey, 'Content-Type': 'application/json' }
}

function parseCast(cast: Record<string, unknown>): BountycasterBounty | null {
  const text = (cast.text as string) ?? ''

  // Skip non-open bounties
  if (CLAIMED_RE.test(text)) return null

  const match = AMOUNT_RE.exec(text)
  if (!match) return null

  const reward = parseFloat(match[1].replace(/,/g, ''))
  if (reward < 50) return null  // skip low-value

  // First line is usually the title, rest is description
  const lines = text.trim().split('\n').filter(Boolean)
  const title = lines[0]?.slice(0, 100) ?? 'Untitled bounty'
  const description = lines.slice(1).join('\n').trim() || text

  const author = cast.author as Record<string, unknown>

  return {
    id: cast.hash as string,
    title,
    description,
    reward,
    token: 'USDC',
    castUrl: `https://warpcast.com/~/conversations/${cast.hash}`,
    authorFid: (author?.fid as number) ?? 0,
    timestamp: cast.timestamp as string,
  }
}

export async function listOpenBounties(apiKey: string): Promise<BountycasterBounty[]> {
  const res = await fetch(
    `${NEYNAR}/farcaster/feed/channels?channel_ids=${BOUNTYBOT_CHANNEL}&limit=50&should_moderate=false`,
    { headers: headers(apiKey), signal: AbortSignal.timeout(12_000) }
  )
  if (!res.ok) throw new Error(`Neynar feed failed: ${res.status}`)

  const data = await res.json()
  const casts: Record<string, unknown>[] = data.casts ?? []

  return casts
    .map(parseCast)
    .filter((b): b is BountycasterBounty => b !== null)
    .sort((a, b) => b.reward - a.reward)
}
