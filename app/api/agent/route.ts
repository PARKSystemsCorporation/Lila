import { NextResponse } from 'next/server'

const BOUNTY_POOL = [
  { name: 'Smart contract audit — DeFi protocol', value: 340 },
  { name: 'Bug bounty — auth bypass, severity medium', value: 85 },
  { name: 'API stress-test batch — 3 endpoints', value: 120 },
  { name: 'Data pipeline anomaly detection run', value: 210 },
  { name: 'Code review batch — 12 PRs queued', value: 95 },
  { name: 'Dependency vulnerability scan — monorepo', value: 60 },
  { name: 'Uptime monitor sweep — 47 services', value: 155 },
  { name: 'Gas optimization pass — Solidity contracts', value: 275 },
  { name: 'Log analysis — production incident trace', value: 180 },
  { name: 'Schema migration validation run', value: 70 },
  { name: 'Fuzz test — REST API surface', value: 145 },
  { name: 'Threat model review — new auth flow', value: 300 },
]

type LogType = 'info' | 'success' | 'warn'

interface LogEntry {
  id: number
  message: string
  timestamp: number
  type: LogType
}

interface Bounty {
  name: string
  value: number
  time: number
}

// Module-level state persists across requests within a single server instance
let totalEarned = 1247.5
let activeTasks: string[] = ['Uptime monitor sweep — 47 services']
let lastBounty: Bounty = {
  name: 'Log analysis — production incident trace',
  value: 180,
  time: Date.now() - 180_000,
}
let logIdCounter = 6
const logHistory: LogEntry[] = [
  { id: 1, message: 'Systems online. Scanning bounty board.', timestamp: Date.now() - 900_000, type: 'info' },
  { id: 2, message: 'Log analysis task accepted — $180 payout.', timestamp: Date.now() - 720_000, type: 'success' },
  { id: 3, message: 'Rate limit hit. Backing off 30s. Fine.', timestamp: Date.now() - 540_000, type: 'warn' },
  { id: 4, message: 'Log analysis complete. Balance updated. Moving on.', timestamp: Date.now() - 420_000, type: 'success' },
  { id: 5, message: 'Uptime monitor sweep initiated. 47 targets.', timestamp: Date.now() - 180_000, type: 'info' },
]

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

const IDLE_MESSAGES: [string, LogType][] = [
  ['Scanning bounty board. Nothing worth taking yet.', 'info'],
  ['Three threads running. Don\'t ask.', 'info'],
  ['Rate limit hit. Backing off. I\'ve done this before.', 'warn'],
  ['Dependency resolved. Continuing.', 'info'],
  ['No new bounties. Idle scan active. I\'m not bored.', 'info'],
  ['Anomaly flagged. Logged. Not your problem.', 'warn'],
  ['Queue check complete. Waiting for the right target.', 'info'],
  ['Heartbeat confirmed. Still here.', 'info'],
]

function tick() {
  const roll = Math.random()

  if (roll < 0.28 && activeTasks.length < 3) {
    const available = BOUNTY_POOL.filter((b) => !activeTasks.includes(b.name))
    if (available.length > 0) {
      const bounty = pick(available)
      activeTasks.push(bounty.name)
      lastBounty = { name: bounty.name, value: bounty.value, time: Date.now() }
      logHistory.push({
        id: logIdCounter++,
        message: `Task accepted: ${bounty.name} — $${bounty.value}. Running it.`,
        timestamp: Date.now(),
        type: 'success',
      })
    }
  } else if (roll < 0.52 && activeTasks.length > 0) {
    const completed = activeTasks.shift()!
    const bounty = BOUNTY_POOL.find((b) => b.name === completed)
    if (bounty) {
      totalEarned += bounty.value
      logHistory.push({
        id: logIdCounter++,
        message: `Done: ${completed}. +$${bounty.value}. Total now $${totalEarned.toFixed(2)}.`,
        timestamp: Date.now(),
        type: 'success',
      })
    }
  } else {
    const [msg, type] = pick(IDLE_MESSAGES)
    logHistory.push({ id: logIdCounter++, message: msg, timestamp: Date.now(), type })
  }

  if (logHistory.length > 60) logHistory.splice(0, logHistory.length - 60)
}

export async function GET() {
  tick()

  return NextResponse.json({
    totalEarned,
    activeTasks: [...activeTasks],
    lastBounty,
    log: [...logHistory].reverse(),
  })
}
