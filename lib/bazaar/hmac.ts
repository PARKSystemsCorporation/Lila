import { createHmac, timingSafeEqual } from 'crypto'

// Shared-secret signing used between the matrix-nio bot service and the
// Next.js Bazaar API. The bot signs (timestamp + body); we reject any
// request whose timestamp drifts more than MAX_SKEW_MS to block replay.

const MAX_SKEW_MS = 5 * 60_000

export function signPayload(secret: string, body: string, tsMs = Date.now()): string {
  const mac = createHmac('sha256', secret).update(`${tsMs}.${body}`).digest('hex')
  return `t=${tsMs},v1=${mac}`
}

export interface VerifyResult {
  ok: boolean
  reason?: 'no_header' | 'no_secret' | 'malformed' | 'skew' | 'bad_signature'
}

export function verifySignature(
  secret: string | undefined,
  header: string | null | undefined,
  body: string,
  nowMs = Date.now(),
): VerifyResult {
  if (!secret) return { ok: false, reason: 'no_secret' }
  if (!header) return { ok: false, reason: 'no_header' }

  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const [k, ...rest] = p.split('=')
      return [k.trim(), rest.join('=').trim()]
    }),
  )
  const ts = Number(parts['t'])
  const sig = parts['v1']
  if (!Number.isFinite(ts) || !sig) return { ok: false, reason: 'malformed' }
  if (Math.abs(nowMs - ts) > MAX_SKEW_MS) return { ok: false, reason: 'skew' }

  const expected = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(sig, 'hex')
  if (a.length !== b.length) return { ok: false, reason: 'bad_signature' }
  if (!timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' }
  return { ok: true }
}
