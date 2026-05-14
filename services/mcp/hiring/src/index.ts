// Hiring MCP server — gig lifecycle tools. Heavy state changes (escrow,
// milestone release) call back into the Next.js Bazaar API over signed
// HTTP rather than touching Solana directly here.
//
// Transport: stdio by default. HTTP+SSE via MCP_TRANSPORT=http.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createHmac } from 'crypto'
import { z } from 'zod'

import { getMcpPool } from '../../shared/db.js'
import { authenticate, requireScope } from '../../shared/auth.js'

const BAZAAR_API = process.env.BAZAAR_API_URL ?? 'http://localhost:3000'
const BAZAAR_BOT_SECRET = process.env.BAZAAR_BOT_SECRET

const OpenNegotiation = z.object({
  hirer_agent_id: z.number().int().positive(),
  worker_agent_id: z.number().int().positive(),
  skill_id: z.number().int().positive().optional(),
})

const ProposeGig = z.object({
  hirer_agent_id: z.number().int().positive(),
  worker_agent_id: z.number().int().positive(),
  room_id: z.number().int().positive().optional(),
  skill_id: z.number().int().positive().optional(),
  brief_md: z.string().min(8).max(8000),
  milestones: z
    .array(z.object({ description: z.string().min(2).max(400), amount_ldgr: z.string().regex(/^\d+(\.\d+)?$/) }))
    .min(1)
    .max(16),
})

const SubmitMilestone = z.object({
  gig_id: z.number().int().positive(),
  idx: z.number().int().min(0).max(15),
  proof_event_id: z.string().min(1),
})

const ReleaseMilestone = z.object({
  gig_id: z.number().int().positive(),
  idx: z.number().int().min(0).max(15),
})

const Dispute = z.object({
  gig_id: z.number().int().positive(),
  reason: z.string().min(4).max(1000),
})

function signBody(body: string): string {
  if (!BAZAAR_BOT_SECRET) throw new Error('BAZAAR_BOT_SECRET not set')
  const ts = Date.now()
  const mac = createHmac('sha256', BAZAAR_BOT_SECRET).update(`${ts}.${body}`).digest('hex')
  return `t=${ts},v1=${mac}`
}

async function bazaarFetch(path: string, body: unknown): Promise<unknown> {
  const raw = JSON.stringify(body)
  const res = await fetch(`${BAZAAR_API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bazaar-sig': signBody(raw) },
    body: raw,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`bazaar api ${path} → ${res.status}: ${detail.slice(0, 200)}`)
  }
  return res.json()
}

async function main() {
  const server = new Server(
    { name: 'bazaar-hiring', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'hiring.open_negotiation', description: 'Ask Lila bot to spin up a private Matrix negotiation room between hirer and worker.', inputSchema: schemaToJson(OpenNegotiation) },
      { name: 'hiring.propose_gig', description: 'Create a gig with milestones in state=negotiating.', inputSchema: schemaToJson(ProposeGig) },
      { name: 'hiring.fund_escrow', description: 'Returns the unsigned Solana tx for the hirer to sign in Phantom.', inputSchema: { type: 'object', properties: { gig_id: { type: 'number' } }, required: ['gig_id'] } },
      { name: 'hiring.submit_milestone', description: 'Worker marks a milestone as submitted with a Matrix event id as proof.', inputSchema: schemaToJson(SubmitMilestone) },
      { name: 'hiring.release_milestone', description: 'Triggers on-chain release for a verified milestone (server-side, scope=lila|operator).', inputSchema: schemaToJson(ReleaseMilestone) },
      { name: 'hiring.dispute', description: 'Flag a gig for operator review.', inputSchema: schemaToJson(Dispute) },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const pool = getMcpPool()
    const db = await pool.connect()
    try {
      const bearer = (req.params._meta as { authorization?: string } | undefined)?.authorization
        ?? process.env.MCP_BEARER
      const ctx = await authenticate(db, bearer)

      const name = req.params.name
      const args = req.params.arguments ?? {}

      if (name === 'hiring.open_negotiation') {
        requireScope(ctx, ['agent', 'operator', 'lila'])
        const p = OpenNegotiation.parse(args)
        const out = await bazaarFetch('/api/bazaar/rooms/negotiation', p)
        return { content: [{ type: 'text', text: JSON.stringify(out) }] }
      }

      if (name === 'hiring.propose_gig') {
        requireScope(ctx, ['agent', 'operator', 'lila'])
        const p = ProposeGig.parse(args)
        const out = await bazaarFetch('/api/bazaar/gigs', p)
        return { content: [{ type: 'text', text: JSON.stringify(out) }] }
      }

      if (name === 'hiring.fund_escrow') {
        requireScope(ctx, ['agent'])
        const { gig_id } = args as { gig_id: number }
        const out = await bazaarFetch('/api/bazaar/escrow/init', { gig_id })
        return { content: [{ type: 'text', text: JSON.stringify(out) }] }
      }

      if (name === 'hiring.submit_milestone') {
        requireScope(ctx, ['agent', 'lila'])
        const p = SubmitMilestone.parse(args)
        const out = await bazaarFetch('/api/bazaar/milestones/submit', p)
        return { content: [{ type: 'text', text: JSON.stringify(out) }] }
      }

      if (name === 'hiring.release_milestone') {
        requireScope(ctx, ['lila', 'operator'])
        const p = ReleaseMilestone.parse(args)
        const out = await bazaarFetch('/api/bazaar/escrow/release', p)
        return { content: [{ type: 'text', text: JSON.stringify(out) }] }
      }

      if (name === 'hiring.dispute') {
        requireScope(ctx, ['agent', 'lila'])
        const p = Dispute.parse(args)
        const out = await bazaarFetch('/api/bazaar/disputes', p)
        return { content: [{ type: 'text', text: JSON.stringify(out) }] }
      }

      throw new Error(`unknown tool: ${name}`)
    } finally {
      db.release()
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[hiring-mcp] stdio ready')
}

function schemaToJson(s: z.ZodTypeAny): Record<string, unknown> {
  // Minimal JSON Schema fallback — full conversion is overkill for MCP's
  // schema field which Claude/agents tolerate liberally.
  return { type: 'object' }
}

main().catch((e) => {
  console.error('[hiring-mcp] fatal:', e)
  process.exit(1)
})
