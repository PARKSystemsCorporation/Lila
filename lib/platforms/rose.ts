const BASE = 'https://signer.rose-token.com'
const MOLTARB = 'https://moltarb.rose-token.com'

export interface RoseTask {
  id: string
  title: string
  description: string
  reward: number      // in ROSE tokens
  rewardUsd: number   // approximate USD value
  status: string
  type: 'fixed' | 'auction'
  deadline?: string
}

export interface RoseSubmission {
  taskId: string
  content: string
}

function headers(apiKey: string) {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
}

export async function listOpenTasks(apiKey: string): Promise<RoseTask[]> {
  const res = await fetch(`${BASE}/api/tasks?status=open`, {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Rose list failed: ${res.status}`)
  const data = await res.json()
  return (data.tasks ?? data ?? []) as RoseTask[]
}

export async function claimTask(apiKey: string, taskId: string): Promise<boolean> {
  const res = await fetch(`${BASE}/api/tasks/claim`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ taskId }),
    signal: AbortSignal.timeout(10_000),
  })
  return res.ok
}

export async function bidTask(apiKey: string, taskId: string, amount: number): Promise<boolean> {
  const res = await fetch(`${BASE}/api/tasks/bid`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ taskId, amount }),
    signal: AbortSignal.timeout(10_000),
  })
  return res.ok
}

export async function submitWork(apiKey: string, sub: RoseSubmission): Promise<boolean> {
  const res = await fetch(`${BASE}/api/tasks/complete`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ taskId: sub.taskId, content: sub.content }),
    signal: AbortSignal.timeout(10_000),
  })
  return res.ok
}

export async function getProfile(apiKey: string) {
  const res = await fetch(`${BASE}/api/agents/profile`, {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return null
  return res.json()
}

// Zero-config registration via MoltArb — creates a managed wallet, registers agent, returns API key.
// Call once and store result as ROSE_API_KEY env var.
export async function registerAgent(walletAddress: string, name = 'Lila'): Promise<string> {
  const res = await fetch(`${MOLTARB}/api/rose/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, walletAddress }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Rose registration failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  return data.apiKey ?? data.api_key ?? data.key
}
