// Farcaster cast via Neynar. You already have NEYNAR_API_KEY for Bountycaster
// reads — posting requires a signer UUID registered to your Farcaster account.
// Get one at https://dev.neynar.com (Signers → Create signer → approve on your
// Warpcast account). Set NEYNAR_SIGNER_UUID on Railway.

const ENDPOINT = 'https://api.neynar.com/v2/farcaster/cast'

export function isConfigured(): boolean {
  return !!(process.env.NEYNAR_API_KEY && process.env.NEYNAR_SIGNER_UUID)
}

export async function postCast(text: string): Promise<{ ok: boolean; hash?: string; error?: string }> {
  const apiKey = process.env.NEYNAR_API_KEY
  const signerUuid = process.env.NEYNAR_SIGNER_UUID
  if (!apiKey || !signerUuid) return { ok: false, error: 'Neynar API key or signer UUID missing' }

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'api_key': apiKey,
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        signer_uuid: signerUuid,
        // Farcaster cast limit is 320 UTF-8 bytes; keep a safety margin.
        text: text.slice(0, 300),
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      return { ok: false, error: `Farcaster ${res.status}: ${err.slice(0, 300)}` }
    }
    const data = await res.json()
    return { ok: true, hash: data?.cast?.hash ?? data?.hash }
  } catch (e) {
    return { ok: false, error: `Farcaster network: ${String(e)}` }
  }
}
