// Phantom signature verification for /api/bazaar/wallet/link.
//
// Flow:
//   1) Client GETs a challenge from /api/bazaar/wallet/link (returns a
//      one-time nonce signed by us; viewer-scoped, 5-min TTL).
//   2) User signs the challenge in Phantom (signMessage).
//   3) Client POSTs { pubkey, signature, challenge } back; we verify the
//      Ed25519 signature against the Solana pubkey and the challenge HMAC.

import { createHmac, timingSafeEqual } from 'crypto'
import { requireOptional } from './_dynamic'

const CHALLENGE_TTL_MS = 5 * 60_000

export function buildChallenge(viewerId: number, secret: string, tsMs = Date.now()): string {
  const nonce = createHmac('sha256', secret)
    .update(`wallet-link:${viewerId}:${tsMs}`)
    .digest('hex')
    .slice(0, 32)
  const body = JSON.stringify({ v: 1, viewer_id: viewerId, ts: tsMs, nonce })
  return Buffer.from(body, 'utf8').toString('base64url')
}

export interface ParsedChallenge {
  viewerId: number
  tsMs: number
  nonce: string
}

export function parseChallenge(
  encoded: string,
  viewerId: number,
  secret: string,
  nowMs = Date.now(),
): ParsedChallenge | null {
  let json: { v?: number; viewer_id?: number; ts?: number; nonce?: string }
  try {
    json = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (json.v !== 1 || json.viewer_id !== viewerId) return null
  if (typeof json.ts !== 'number' || typeof json.nonce !== 'string') return null
  if (Math.abs(nowMs - json.ts) > CHALLENGE_TTL_MS) return null

  const expected = createHmac('sha256', secret)
    .update(`wallet-link:${viewerId}:${json.ts}`)
    .digest('hex')
    .slice(0, 32)
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(json.nonce, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  return { viewerId, tsMs: json.ts, nonce: json.nonce }
}

interface NaclMod {
  default: { sign: { detached: { verify: (msg: Uint8Array, sig: Uint8Array, pub: Uint8Array) => boolean } } }
}
interface Bs58Mod { default: { decode: (s: string) => Uint8Array } }

// Verifies an Ed25519 signature produced by Phantom's signMessage over the
// challenge bytes. The deps are dynamic-imported through the webpack-opaque
// indirection so the Next.js build doesn't require them.
export async function verifyEd25519(
  challenge: string,
  signatureBase58: string,
  pubkeyBase58: string,
): Promise<boolean> {
  const nacl = (await requireOptional('tweetnacl')) as unknown as NaclMod
  const bs58 = (await requireOptional('bs58')) as unknown as Bs58Mod
  const sig = bs58.default.decode(signatureBase58)
  const pub = bs58.default.decode(pubkeyBase58)
  const msg = new TextEncoder().encode(challenge)
  return nacl.default.sign.detached.verify(msg, sig, pub)
}
