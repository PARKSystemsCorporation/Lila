import * as Superteam from '@/lib/platforms/superteam'
import * as Bountycaster from '@/lib/platforms/bountycaster'
import * as Immunefi from '@/lib/platforms/immunefi'
import * as ClawTasks from '@/lib/platforms/clawtasks'

export type BountySource = 'superteam' | 'bountycaster' | 'immunefi' | 'clawtasks'

export interface UnifiedBounty {
  id: string
  platform: BountySource
  platformLabel: string
  title: string
  description: string
  reward: number
  token: string
  url?: string
  deadline?: string
  readOnly: boolean
  chain: string
}

export async function fetchAllBounties(): Promise<UnifiedBounty[]> {
  const results: UnifiedBounty[] = []
  const tasks: Promise<void>[] = []

  if (process.env.SUPERTEAM_API_KEY) {
    tasks.push(
      Superteam.listOpenBounties(process.env.SUPERTEAM_API_KEY)
        .then(items => items.forEach(b => results.push({
          id: `st_${b.id}`,
          platform: 'superteam',
          platformLabel: 'Superteam',
          title: b.title,
          description: b.description,
          reward: b.rewardAmount,
          token: b.token || 'USDC',
          url: `https://earn.superteam.fun/listings/${b.slug}`,
          deadline: b.deadline,
          readOnly: false,
          chain: 'Solana',
        })))
        .catch(() => {})
    )
  }

  if (process.env.NEYNAR_API_KEY) {
    tasks.push(
      Bountycaster.listOpenBounties(process.env.NEYNAR_API_KEY)
        .then(items => items.forEach(b => results.push({
          id: `bc_${b.id}`,
          platform: 'bountycaster',
          platformLabel: 'Bountycaster',
          title: b.title,
          description: b.description,
          reward: b.reward,
          token: b.token,
          url: b.castUrl,
          deadline: undefined,
          readOnly: false,
          chain: 'Base',
        })))
        .catch(() => {})
    )
  }

  if (process.env.CLAWTASKS_API_KEY) {
    tasks.push(
      ClawTasks.listOpenBounties(process.env.CLAWTASKS_API_KEY)
        .then(items => items.forEach(b => results.push({
          id: `ct_${b.id}`,
          platform: 'clawtasks',
          platformLabel: 'ClawTasks',
          title: b.title,
          description: b.description,
          reward: b.reward ?? 0,
          token: 'USDC',
          deadline: b.deadline,
          readOnly: false,
          chain: 'Base',
        })))
        .catch(() => {})
    )
  }

  tasks.push(
    Immunefi.listPrograms()
      .then(items => items.forEach(p => results.push({
        id: `imf_${p.id}`,
        platform: 'immunefi',
        platformLabel: 'Immunefi',
        title: p.title,
        description: `Max bounty: $${p.maxBounty.toLocaleString()} ${p.rewardsToken}. KYC: ${p.kyc ? 'required' : 'not required'}.`,
        reward: p.maxBounty,
        token: p.rewardsToken,
        url: p.url,
        readOnly: true,
        chain: 'Various',
      })))
      .catch(() => {})
  )

  await Promise.all(tasks)

  return results.sort((a, b) => {
    if (a.readOnly !== b.readOnly) return a.readOnly ? 1 : -1
    return b.reward - a.reward
  })
}
