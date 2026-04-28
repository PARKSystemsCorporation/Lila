// Gumroad license-key verification.
//
// Docs: https://help.gumroad.com/article/76-license-keys
// Endpoint: POST https://api.gumroad.com/v2/licenses/verify
//   form fields: product_id, license_key, increment_uses_count
// Response: { success, uses, purchase: { ... } }
//
// For subscription products, `purchase` carries:
//   subscription_id
//   subscription_cancelled_at
//   subscription_failed_at
//   subscription_ended_at
// Active subscription = none of those three timestamps set.

const ENDPOINT = 'https://api.gumroad.com/v2/licenses/verify'

export interface GumroadVerifyResult {
  ok: boolean
  active: boolean             // true = key valid AND subscription still active (or one-time purchase)
  productId: string | null
  subscriptionId: string | null
  email: string | null
  refunded: boolean
  cancelled: boolean
  failed: boolean
  ended: boolean
  uses: number | null
  raw: unknown                // full Gumroad response, for logging
  error?: string
}

interface GumroadPurchase {
  product_permalink?: string
  product_id?: string
  email?: string
  refunded?: boolean
  subscription_id?: string
  subscription_cancelled_at?: string | null
  subscription_failed_at?: string | null
  subscription_ended_at?: string | null
}

interface GumroadResponse {
  success: boolean
  uses?: number
  message?: string
  purchase?: GumroadPurchase
}

export async function verifyLicense(
  productId: string,
  licenseKey: string,
  options: { incrementUses?: boolean } = {},
): Promise<GumroadVerifyResult> {
  if (!productId || !licenseKey) {
    return blank({ error: 'product_id + license_key required' })
  }

  const body = new URLSearchParams({
    product_id: productId,
    license_key: licenseKey,
    increment_uses_count: String(options.incrementUses ?? false),
  })

  let raw: GumroadResponse | null = null
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    })
    raw = await res.json().catch(() => null)
    if (!res.ok || !raw?.success) {
      return blank({ raw, error: raw?.message ?? `gumroad ${res.status}` })
    }
  } catch (e) {
    return blank({ error: `network: ${String(e).slice(0, 120)}` })
  }

  const purchase = raw?.purchase ?? {}
  const refunded   = Boolean(purchase.refunded)
  const cancelled  = !!purchase.subscription_cancelled_at
  const failed     = !!purchase.subscription_failed_at
  const ended      = !!purchase.subscription_ended_at
  const active     = !refunded && !cancelled && !failed && !ended

  return {
    ok: true,
    active,
    productId: purchase.product_permalink ?? purchase.product_id ?? null,
    subscriptionId: purchase.subscription_id ?? null,
    email: purchase.email ?? null,
    refunded, cancelled, failed, ended,
    uses: typeof raw?.uses === 'number' ? raw.uses : null,
    raw,
  }
}

function blank(extra: Partial<GumroadVerifyResult>): GumroadVerifyResult {
  return {
    ok: false, active: false,
    productId: null, subscriptionId: null, email: null,
    refunded: false, cancelled: false, failed: false, ended: false,
    uses: null, raw: null,
    ...extra,
  }
}

export function isConfigured(): boolean {
  return !!(process.env.GUMROAD_PRODUCT_ID && process.env.VIEWER_COOKIE_SECRET)
}
