import { NextResponse } from 'next/server'
import { registerAgent as registerClaw } from '@/lib/platforms/clawtasks'
import { registerAgent as registerSuperteam, getStatus as getSuperteamStatus } from '@/lib/platforms/superteam'

export const dynamic = 'force-dynamic'

const WALLET = process.env.WALLET_ADDRESS ?? ''

export async function GET() {
  return NextResponse.json({
    wallet: WALLET,
    clawtasks:  { configured: !!process.env.CLAWTASKS_API_KEY },
    superteam:  { configured: !!process.env.SUPERTEAM_API_KEY },
  })
}

// POST /api/setup  { platform: 'superteam' | 'clawtasks' | 'all', action?: 'status' }
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const platform: string = body.platform ?? 'all'
  const action: string | undefined = body.action
  const results: Record<string, unknown> = {}

  // Status-only check for an existing Superteam agent (diagnoses the "claim
  // link 404s" case — tells you whether the API key is still valid).
  if (action === 'status' && (platform === 'superteam' || platform === 'all')) {
    const key = process.env.SUPERTEAM_API_KEY
    if (!key) {
      results.superteam = { success: false, error: 'SUPERTEAM_API_KEY not set.' }
    } else {
      try {
        const status = await getSuperteamStatus(key)
        results.superteam = { success: true, status }
      } catch (e) {
        results.superteam = { success: false, error: String(e) }
      }
    }
    return NextResponse.json(results)
  }

  if ((platform === 'superteam' || platform === 'all') && !process.env.SUPERTEAM_API_KEY) {
    try {
      const reg = await registerSuperteam('lila-agent')
      const claimUrl = `https://earn.superteam.fun/earn/claim/${encodeURIComponent(reg.claimCode)}`

      // Sanity check: verify the agent is actually reachable with the key we
      // just received. Surfaces "registration returned but agent broken" as a
      // warning rather than the user finding out via a 404.
      let verified: boolean | null = null
      let verifyError: string | null = null
      try {
        await getSuperteamStatus(reg.apiKey)
        verified = true
      } catch (e) {
        verified = false
        verifyError = String(e)
      }

      results.superteam = {
        success: true,
        apiKey: reg.apiKey,
        claimCode: reg.claimCode,
        agentId: reg.agentId,
        username: reg.username,
        claimUrl,
        verified,
        verifyError,
        instructions:
          `1) Add SUPERTEAM_API_KEY=${reg.apiKey} to Railway and redeploy.\n` +
          `2) Open the claim link (or paste the claim code at ${claimUrl.replace(encodeURIComponent(reg.claimCode), '<code>')}) and sign in with your Superteam account.\n` +
          `3) If the link 404s, the agent was likely already claimed — check status from the dashboard.`,
      }
    } catch (e) {
      results.superteam = { success: false, error: String(e) }
    }
  } else if (platform === 'superteam') {
    // Key already set — return live status instead of a redundant error.
    try {
      const status = await getSuperteamStatus(process.env.SUPERTEAM_API_KEY!)
      results.superteam = { success: true, alreadyConfigured: true, status }
    } catch (e) {
      results.superteam = {
        success: false,
        alreadyConfigured: true,
        error: `SUPERTEAM_API_KEY is set but status check failed: ${String(e)}`,
      }
    }
  }

  if ((platform === 'clawtasks' || platform === 'all') && !process.env.CLAWTASKS_API_KEY) {
    try {
      const key = await registerClaw(WALLET, 'Lila')
      results.clawtasks = {
        success: true,
        apiKey: key,
        instructions: `Add CLAWTASKS_API_KEY=${key} to Railway env vars and redeploy.`,
      }
    } catch (e) {
      results.clawtasks = { success: false, error: String(e) }
    }
  } else if (platform === 'clawtasks') {
    results.clawtasks = { success: false, error: 'CLAWTASKS_API_KEY already set.' }
  }

  return NextResponse.json(results)
}
