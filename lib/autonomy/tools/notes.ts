import type { PoolClient } from 'pg'
import { cfg } from '../../config'

// Notes tools backed by the existing analyst_notes table (path-keyed
// markdown). v1 defaults: 'mkdir' = upsert ${prefix}/.keep with empty
// content; 'json_edit' = read → JSON.parse-or-{} → shallow-merge → write.
// Real filesystem writes are out of scope for v1 — this keeps the blast
// radius bounded to one DB table.

const ROOT_HINT = 'lila/'

function safePath(path: string): string {
  // Strip leading slashes and keep within a safe character set.
  let p = path.trim().replace(/^\/+/, '')
  if (!p) p = `${ROOT_HINT}untitled-${Date.now()}.md`
  // Normalize .. away — analyst_notes is a flat key store but callers tend
  // to think filesystem; protect against escape attempts in case the path
  // ever leaks into a real fs adapter.
  p = p.replace(/\.\.+\//g, '')
  return p.slice(0, 240)
}

export async function read(db: PoolClient, args: { path: string }): Promise<{ path: string; content: string | null; logMessage: string }> {
  const path = safePath(args.path)
  const { rows: [row] } = await db.query(
    `SELECT content FROM analyst_notes WHERE path=$1 LIMIT 1`,
    [path]
  )
  return {
    path,
    content: row?.content ?? null,
    logMessage: row ? `notes.read ${path} (${(row.content ?? '').length}B)` : `notes.read ${path} (missing)`,
  }
}

export async function write(db: PoolClient, args: { path: string; content: string }): Promise<{ path: string; logMessage: string }> {
  const path = safePath(args.path)
  const content = String(args.content ?? '').slice(0, 64_000)
  if (cfg.LILA_DRY_RUN) {
    return { path, logMessage: `[dry-run] notes.write ${path} (${content.length}B)` }
  }
  await db.query(
    `INSERT INTO analyst_notes (path, content)
     VALUES ($1,$2)
     ON CONFLICT (path) DO UPDATE
       SET content=EXCLUDED.content, updated_at=NOW()`,
    [path, content]
  )
  return { path, logMessage: `notes.write ${path} (${content.length}B)` }
}

// 'mkdir' for the path-store: create a hidden marker so the prefix is
// visible to listings.
export async function mkdir(db: PoolClient, args: { prefix: string }): Promise<{ prefix: string; logMessage: string }> {
  let prefix = String(args.prefix ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '')
  if (!prefix) return { prefix: '', logMessage: 'notes.mkdir: empty prefix' }
  prefix = prefix.slice(0, 200)
  const path = safePath(`${prefix}/.keep`)
  if (cfg.LILA_DRY_RUN) {
    return { prefix, logMessage: `[dry-run] notes.mkdir ${prefix}/` }
  }
  await db.query(
    `INSERT INTO analyst_notes (path, content)
     VALUES ($1,$2)
     ON CONFLICT (path) DO NOTHING`,
    [path, `# ${prefix}\n\nIndex note for the ${prefix}/ namespace.\n`]
  )
  return { prefix, logMessage: `notes.mkdir ${prefix}/` }
}

// Shallow-merge JSON edit. Reads the path; if it parses as a JSON object,
// merges 'patch' into it (top-level keys overwritten). Falls back to
// writing 'patch' as the new content on parse failure.
export async function jsonEdit(db: PoolClient, args: { path: string; patch: Record<string, unknown> }): Promise<{ path: string; logMessage: string }> {
  const path = safePath(args.path)
  const patch = (args.patch && typeof args.patch === 'object') ? args.patch : {}
  const { rows: [row] } = await db.query(
    `SELECT content FROM analyst_notes WHERE path=$1 LIMIT 1`,
    [path]
  )
  let merged: Record<string, unknown> = {}
  if (row?.content) {
    try {
      const parsed: unknown = JSON.parse(row.content)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        merged = parsed as Record<string, unknown>
      }
    } catch { /* fall through with empty base */ }
  }
  const next = { ...merged, ...patch }
  const content = JSON.stringify(next, null, 2)
  if (cfg.LILA_DRY_RUN) {
    return { path, logMessage: `[dry-run] notes.json_edit ${path} (${Object.keys(patch).length} keys)` }
  }
  await db.query(
    `INSERT INTO analyst_notes (path, content)
     VALUES ($1,$2)
     ON CONFLICT (path) DO UPDATE
       SET content=EXCLUDED.content, updated_at=NOW()`,
    [path, content]
  )
  return { path, logMessage: `notes.json_edit ${path} (${Object.keys(patch).length} keys)` }
}
