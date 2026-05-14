// Shared Postgres pool for both MCP servers. Connects to the same
// DATABASE_URL as the Next.js app, so writes are immediately visible.

import pg from 'pg'

let pool: pg.Pool | null = null

export function getMcpPool(): pg.Pool {
  if (pool) return pool
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL not set for MCP server')
  pool = new pg.Pool({
    connectionString: url,
    ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 4,
  })
  return pool
}
