import type { PoolClient } from 'pg'
import { cfg } from './config'

// ── Artist: autonomous painter ───────────────────────────────────────────
//
// Generates one piece per cycle via fal.ai's hosted FLUX.1 schnell
// (Apache-2.0, ~$0.003/image). Stores the bytes inline as base64 in
// `artist_gallery` so we don't need a blob store. Trims the gallery to
// the most recent ARTIST_GALLERY_LIMIT pieces after each insert.
//
// One step per cycle, time-gated by ARTIST_RUN_SEC (default 3600s):
//   A0 — pick a theme, POST to fal.ai, fetch bytes, persist, trim.
//
// No-ops cleanly when FAL_API_KEY isn't set (Floor tile shows artist as
// off-shift).

const FAL_ENDPOINT = 'https://fal.run/fal-ai/flux/schnell'
const FAL_TIMEOUT_MS = 30_000

const THEMES = [
  'brutalist concrete vault under amber neon, slate fog, cinematic, ultra wide',
  'neon spread chart melting into a city skyline at dawn, grain, anamorphic',
  'a lone analyst watching ticker tape rain in a dark glass office, soft volumetric light',
  'rusted shipping containers stacked into a market exchange, dawn haze, kodak portra',
  'concrete cathedral lit by emerald CRT screens, rain on the windows',
  'monochrome trading floor reflected in a black puddle, neon amber accents',
  'an empty stadium under heavy snow, scoreboard glowing magenta, painterly',
  'rolling hills made of stacked candlestick charts, twilight, soft fog',
  'a quiet observatory tracking commodity flows, brass and walnut, candlelight',
  'futurist library where the books are bound in foil and ledger paper',
  'shipping cranes silhouetted against a green-and-amber sunset, port of trade',
  'an empty subway car at 4am, screens showing sport spreads, melancholy',
]

interface ArtistResult {
  logMessage: string
  logType: 'info' | 'success' | 'warn'
}

export class ArtistLoop {
  private db: PoolClient
  private apiKey: string

  constructor(db: PoolClient) {
    this.db = db
    this.apiKey = process.env.FAL_API_KEY ?? ''
  }

  async shouldRun(): Promise<boolean> {
    const { rows: [s] } = await this.db.query(
      'SELECT last_step_at FROM artist_state WHERE id=1'
    )
    if (!s?.last_step_at) return true
    return (Date.now() - new Date(s.last_step_at).getTime()) / 1000 >= cfg.ARTIST_RUN_SEC
  }

  async run(): Promise<ArtistResult | null> {
    if (!this.apiKey) return null
    if (!(await this.shouldRun())) return null

    await this.maybeIntroduce()

    if (await this.dailyBudgetExceeded()) {
      await this.markStep()
      return { logMessage: 'Artist: daily budget hit, skipping.', logType: 'warn' }
    }

    const cycle = await this.currentCycle()
    const prompt = THEMES[cycle % THEMES.length]

    let imageBytes: Buffer
    let mime: string
    try {
      const { bytes, contentType } = await this.generate(prompt)
      imageBytes = bytes
      mime = contentType
    } catch (e) {
      await this.markStep()
      return {
        logMessage: `Artist generation error: ${String(e).slice(0, 120)}`,
        logType: 'warn',
      }
    }

    const b64 = imageBytes.toString('base64')
    await this.db.query(
      `INSERT INTO artist_gallery (prompt, image_b64, mime_type, model)
       VALUES ($1, $2, $3, 'flux-schnell')`,
      [prompt, b64, mime]
    )
    await this.trimGallery()
    await this.markStep()
    await this.chat(`Painted: "${prompt.slice(0, 80)}".`)

    return {
      logMessage: `Artist painted: "${prompt.slice(0, 70)}"`,
      logType: 'success',
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async currentCycle(): Promise<number> {
    const { rows: [s] } = await this.db.query('SELECT cycle FROM artist_state WHERE id=1')
    return Number(s?.cycle ?? 0)
  }

  // Cap pieces/day so a runaway loop can't burn the budget. Default cap
  // matches ARTIST_DAILY_BUDGET_USD / ~$0.003 per piece.
  private async dailyBudgetExceeded(): Promise<boolean> {
    const cap = Math.floor(cfg.ARTIST_DAILY_BUDGET_USD / 0.003)
    if (cap <= 0) return false
    const { rows: [r] } = await this.db.query(
      `SELECT COUNT(*)::int AS n
         FROM artist_gallery
        WHERE created_at > NOW() - INTERVAL '24 hours'`
    )
    return Number(r?.n ?? 0) >= cap
  }

  private async generate(prompt: string): Promise<{ bytes: Buffer; contentType: string }> {
    // fal.ai sync endpoint: returns when generation is complete with a
    // signed CDN URL we then fetch. Both calls share one timeout budget.
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FAL_TIMEOUT_MS)
    try {
      const res = await fetch(FAL_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Key ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt,
          image_size: 'square_hd',
          num_inference_steps: 4,
          num_images: 1,
          enable_safety_checker: true,
        }),
        signal: ctrl.signal,
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        throw new Error(`fal ${res.status}: ${txt.slice(0, 160)}`)
      }
      const json = await res.json() as { images?: Array<{ url: string; content_type?: string }> }
      const img = json.images?.[0]
      if (!img?.url) throw new Error('fal returned no image url')

      const imgRes = await fetch(img.url, { signal: ctrl.signal })
      if (!imgRes.ok) throw new Error(`image fetch ${imgRes.status}`)
      const buf = Buffer.from(await imgRes.arrayBuffer())
      return { bytes: buf, contentType: img.content_type ?? 'image/png' }
    } finally {
      clearTimeout(t)
    }
  }

  private async trimGallery(): Promise<void> {
    await this.db.query(
      `DELETE FROM artist_gallery
        WHERE id NOT IN (
          SELECT id FROM artist_gallery ORDER BY id DESC LIMIT 200
        )`
    )
  }

  private async markStep(): Promise<void> {
    await this.db.query(
      `UPDATE artist_state
         SET last_step_at=NOW(), cycle=cycle+1, updated_at=NOW()
       WHERE id=1`
    )
  }

  // One-shot self-introduction. Atomic claim mirrors the other agents.
  private async maybeIntroduce(): Promise<void> {
    const { rows } = await this.db.query(
      `UPDATE artist_state SET introduced_at=NOW()
        WHERE id=1 AND introduced_at IS NULL
        RETURNING id`
    )
    if (!rows.length) return
    await this.chat(
      "Artist online. I paint one piece per cycle from a rotating brand-tinted prompt list — pieces persist in the gallery and surface on the Floor's Studio tile. Tell Lila to swap themes or change cadence.",
      'message',
    )
  }

  private async chat(content: string, kind: 'message' | 'status' = 'status'): Promise<void> {
    await this.db.query(
      `INSERT INTO chat_messages (sender, content, kind) VALUES ($1, $2, $3)`,
      ['artist', content.slice(0, 500), kind]
    )
  }
}
