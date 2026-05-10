import type { PoolClient } from 'pg'
import { cfg } from '../../config'

// Compose a Bluesky post via the existing broadcasts queue. content is the
// published payload (≤260 chars enforced); title and category are
// metadata for the operator UI only.

export interface ComposeArgs {
  title?: string
  category?: string
  content: string
  scheduled_minutes?: number  // delay before publish (default = BROADCAST_PREVIEW_WINDOW_MIN)
}

export async function compose(db: PoolClient, args: ComposeArgs): Promise<{ id: number | null; logMessage: string }> {
  const content = String(args.content ?? '').trim().slice(0, 260)
  if (!content) return { id: null, logMessage: 'bluesky.compose: empty content' }
  const title = args.title ? String(args.title).slice(0, 200) : null
  const category = args.category ? String(args.category).slice(0, 60) : null
  if (cfg.LILA_DRY_RUN) {
    return { id: null, logMessage: `[dry-run] bluesky.compose "${content.slice(0, 60)}"` }
  }
  const delayMin = Math.max(0, Math.min(120, args.scheduled_minutes ?? cfg.BROADCAST_PREVIEW_WINDOW_MIN))
  const { rows: [row] } = await db.query(
    `INSERT INTO broadcasts (channel, content, status, scheduled_publish_at, title, category)
     VALUES ('bluesky', $1, 'pending_publish', NOW() + ($2 || ' minutes')::interval, $3, $4)
     RETURNING id`,
    [content, String(delayMin), title, category]
  )
  return {
    id: Number(row.id),
    logMessage: `bluesky.compose queued #${row.id} +${delayMin}m "${(title ?? content).slice(0, 60)}"`,
  }
}
