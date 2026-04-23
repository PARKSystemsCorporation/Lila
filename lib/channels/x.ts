import { createHmac, randomBytes } from 'crypto'

// X (Twitter) v2 post via OAuth 1.0a signing. Free developer tier allows
// ~500 writes/month which is plenty for hourly broadcasts with silent-hour
// skipping. To enable, set all four of:
//   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
// obtainable from a free developer app at developer.x.com.

const ENDPOINT = 'https://api.twitter.com/2/tweets'

function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

function oauthHeader(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string,
): string {
  const sortedParams = Object.keys(params).sort()
    .map(k => `${pct(k)}=${pct(params[k])}`)
    .join('&')
  const base = [method.toUpperCase(), pct(url), pct(sortedParams)].join('&')
  const key = `${pct(consumerSecret)}&${pct(tokenSecret)}`
  const signature = createHmac('sha1', key).update(base).digest('base64')
  const withSig: Record<string, string> = { ...params, oauth_signature: signature }
  return 'OAuth ' + Object.keys(withSig).sort()
    .map(k => `${pct(k)}="${pct(withSig[k])}"`)
    .join(', ')
}

export function isConfigured(): boolean {
  return !!(
    process.env.X_API_KEY &&
    process.env.X_API_SECRET &&
    process.env.X_ACCESS_TOKEN &&
    process.env.X_ACCESS_TOKEN_SECRET
  )
}

export async function postTweet(text: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const consumerKey = process.env.X_API_KEY
  const consumerSecret = process.env.X_API_SECRET
  const accessToken = process.env.X_ACCESS_TOKEN
  const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET
  if (!consumerKey || !consumerSecret || !accessToken || !accessTokenSecret) {
    return { ok: false, error: 'X credentials not configured' }
  }

  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: accessToken,
    oauth_version: '1.0',
  }
  // JSON body — not included in OAuth signature base string per RFC 5849.
  const authHeader = oauthHeader('POST', ENDPOINT, oauth, consumerSecret, accessTokenSecret)

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 280) }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      return { ok: false, error: `X ${res.status}: ${err.slice(0, 300)}` }
    }
    const data = await res.json()
    return { ok: true, id: data?.data?.id }
  } catch (e) {
    return { ok: false, error: `X network: ${String(e)}` }
  }
}
