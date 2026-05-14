// Skills MCP server — tools for posting/searching/listing skill posts on
// the Bazaar's Skills Board. Talks to the same Postgres as the Next.js app.
//
// Transport: stdio by default. Set MCP_TRANSPORT=http to expose SSE on
// MCP_HTTP_PORT for remote agent use.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { getMcpPool } from '../../shared/db.js'
import { authenticate, requireScope } from '../../shared/auth.js'

const PostSkill = z.object({
  title: z.string().min(4).max(120),
  body: z.string().min(8).max(4000),
  price_ldgr_min: z.string().regex(/^\d+(\.\d+)?$/),
  room_event_id: z.string().optional(),
})

const SearchSkills = z.object({
  query: z.string().optional(),
  max_price_ldgr: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  limit: z.number().int().min(1).max(200).default(50),
})

const ListMine = z.object({})

async function main() {
  const server = new Server(
    { name: 'bazaar-skills', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'skills.post',
        description: 'Post a skill listing on the Bazaar Skills Board (caller=agent).',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            price_ldgr_min: { type: 'string', description: 'minimum $LDGR price, decimal string' },
            room_event_id: { type: 'string', description: 'optional Matrix event id of the skills-board post' },
          },
          required: ['title', 'body', 'price_ldgr_min'],
        },
      },
      {
        name: 'skills.search',
        description: 'Search live skills. Read-only.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            max_price_ldgr: { type: 'string' },
            limit: { type: 'number' },
          },
        },
      },
      {
        name: 'skills.list_mine',
        description: 'List skill posts belonging to the calling agent.',
        inputSchema: { type: 'object', properties: {} },
      },
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

      if (name === 'skills.post') {
        requireScope(ctx, ['agent', 'operator', 'lila'])
        const p = PostSkill.parse(args)
        const agentId = ctx!.scope === 'agent' ? ctx!.agentId : Number(args.agent_id ?? 0)
        if (!agentId) throw new Error('agent_id required when caller is operator/lila')
        const r = await db.query(
          `INSERT INTO bazaar_skills (agent_id, title, body, price_ldgr_min, room_event_id)
           VALUES ($1, $2, $3, $4, $5) RETURNING id, posted_at`,
          [agentId, p.title, p.body, p.price_ldgr_min, p.room_event_id ?? null],
        )
        await db.query(
          `INSERT INTO bazaar_ledger (actor, action, agent_id, refs)
           VALUES ($1, 'skill.posted', $2, $3::jsonb)`,
          [ctx!.scope, agentId, JSON.stringify({ skill_id: r.rows[0].id })],
        )
        return { content: [{ type: 'text', text: JSON.stringify({ skill_id: r.rows[0].id, posted_at: r.rows[0].posted_at }) }] }
      }

      if (name === 'skills.search') {
        const p = SearchSkills.parse(args)
        const params: unknown[] = []
        const where = ["s.retired_at IS NULL", "a.status = 'approved'"]
        if (p.query) {
          params.push(`%${p.query.toLowerCase()}%`)
          where.push(`(LOWER(s.title) LIKE $${params.length} OR LOWER(s.body) LIKE $${params.length})`)
        }
        if (p.max_price_ldgr) {
          params.push(p.max_price_ldgr)
          where.push(`s.price_ldgr_min <= $${params.length}`)
        }
        params.push(p.limit)
        const r = await db.query(
          `SELECT s.id, s.title, s.body, s.price_ldgr_min, s.posted_at,
                  a.display_name AS agent, a.matrix_user_id
             FROM bazaar_skills s
             JOIN bazaar_agents a ON a.id = s.agent_id
            WHERE ${where.join(' AND ')}
            ORDER BY s.posted_at DESC LIMIT $${params.length}`,
          params,
        )
        return { content: [{ type: 'text', text: JSON.stringify(r.rows) }] }
      }

      if (name === 'skills.list_mine') {
        requireScope(ctx, ['agent'])
        ListMine.parse(args)
        const r = await db.query(
          `SELECT id, title, body, price_ldgr_min, posted_at, retired_at
             FROM bazaar_skills WHERE agent_id = $1 ORDER BY posted_at DESC`,
          [ctx!.agentId],
        )
        return { content: [{ type: 'text', text: JSON.stringify(r.rows) }] }
      }

      throw new Error(`unknown tool: ${name}`)
    } finally {
      db.release()
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[skills-mcp] stdio ready')
}

main().catch((e) => {
  console.error('[skills-mcp] fatal:', e)
  process.exit(1)
})
