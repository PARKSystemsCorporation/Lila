import { NextResponse } from 'next/server'
import { registerAgent as registerClaw } from '@/lib/platforms/clawtasks'
import { registerAgent as registerSuperteam } from '@/lib/platforms/superteam'

const WALLET = '0x3a6Dd93f29041aDC2ffB142EdC98434c60110926'

export async function GET() {
  return NextResponse.json({
    wallet: WALLET,
    clawtasks:  { configured: !!process.env.CLAWTASKS_API_KEY },
    superteam:  { configured: !!process.env.SUPERTEAM_API_KEY },
  })
}

// POST /api/setup  { "platform": "clawtasks" | "superteam" | "all" }
export async function POST(req: Request) {
  const { platform } = await req.json().catch(() => ({ platform: 'all' }))
  const results: Record<string, unknown> = {}

  if ((platform === 'superteam' || platform === 'all') && !process.env.SUPERTEAM_API_KEY) {
    try {
      const reg = await registerSuperteam('lila-agent')
      results.superteam = {
        success: true,
        apiKey: reg.apiKey,
        claimCode: reg.claimCode,
        agentId: reg.agentId,
        username: reg.username,
        claimUrl: `https://earn.superteam.fun/earn/claim/${reg.claimCode}`,
        instructions: `Add SUPERTEAM_API_KEY=${reg.apiKey} to Railway env vars. Visit the claim URL above to link payouts to your account.`,
      }
    } catch (e) {
      results.superteam = { success: false, error: String(e) }
    }
  } else if (platform === 'superteam') {
    results.superteam = { success: false, error: 'SUPERTEAM_API_KEY already set.' }
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
