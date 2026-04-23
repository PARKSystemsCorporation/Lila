import { NextResponse } from 'next/server'
import { registerAgent as registerClaw } from '@/lib/platforms/clawtasks'
import { registerAgent as registerRose } from '@/lib/platforms/rose'

const WALLET = '0x3a6Dd93f29041aDC2ffB142EdC98434c60110926'

// GET /api/setup
// Returns current platform registration status and any available API keys.
// Keys are shown ONCE on registration — store them immediately as Railway env vars.
export async function GET() {
  const status: Record<string, unknown> = {
    wallet: WALLET,
    clawtasks: { configured: !!process.env.CLAWTASKS_API_KEY },
    rose: { configured: !!process.env.ROSE_API_KEY },
  }
  return NextResponse.json(status)
}

// POST /api/setup  { "platform": "clawtasks" | "rose" | "all" }
// Registers Lila on the specified platform(s) and returns API keys.
// Add the returned keys to Railway env vars then redeploy.
export async function POST(req: Request) {
  const { platform } = await req.json().catch(() => ({ platform: 'all' }))

  const results: Record<string, unknown> = {}

  if ((platform === 'rose' || platform === 'all') && !process.env.ROSE_API_KEY) {
    try {
      const key = await registerRose(WALLET, 'Lila')
      results.rose = {
        success: true,
        apiKey: key,
        instructions: 'Add ROSE_API_KEY=' + key + ' to Railway env vars and redeploy.',
      }
    } catch (e) {
      results.rose = { success: false, error: String(e) }
    }
  } else if (platform === 'rose') {
    results.rose = { success: false, error: 'ROSE_API_KEY already set.' }
  }

  if ((platform === 'clawtasks' || platform === 'all') && !process.env.CLAWTASKS_API_KEY) {
    try {
      const key = await registerClaw(WALLET, 'Lila')
      results.clawtasks = {
        success: true,
        apiKey: key,
        instructions: 'Add CLAWTASKS_API_KEY=' + key + ' to Railway env vars and redeploy.',
      }
    } catch (e) {
      results.clawtasks = { success: false, error: String(e) }
    }
  } else if (platform === 'clawtasks') {
    results.clawtasks = { success: false, error: 'CLAWTASKS_API_KEY already set.' }
  }

  return NextResponse.json(results)
}
