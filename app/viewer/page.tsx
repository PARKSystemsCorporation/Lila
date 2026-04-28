'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

// ─── Public viewer page ───────────────────────────────────────────────────
//
// Read-only window into Ceelo's edges + the team's published articles.
// Gumroad-license-gated; the operator at / sees the full app, viewers at
// /viewer see only what's listed below. No chat, no config, no telemetry.
//
// Two tabs: EDGES (NFL / NBA / MLB game cards with predicted scores +
// traffic-light) and ARTICLES (published-only Substack drafts inline).

type Sport = 'NFL' | 'NBA' | 'MLB'
type Mode = 'edges' | 'articles'

interface ViewerGame {
  game_id: number
  sport: Sport
  home_team: string
  away_team: string
  home_record: string
  away_record: string
  kickoff_at: number
  consensus_home_spread: number | null
  open_home_spread: number | null
  book_count: number
  model_home_spread: number | null
  model_home_prob: number | null
  predicted_home_score: number | null
  predicted_away_score: number | null
  edge_points: number | null
  edge_team: string | null
  light: 'green' | 'yellow' | 'grey'
}

interface ViewerEdgeFeed {
  games: ViewerGame[]
  byDate: Array<{ date: string; items: ViewerGame[] }>
  meta: { sport: Sport; threshold: number; total_games: number; green_count: number; yellow_count: number; avg_total: number } | null
}

interface ViewerArticle {
  id: number
  title: string
  content: string
  author: 'lila' | 'vega' | 'ceelo'
  kind: string
  external_url: string | null
  created_ts: number
}

const AUTHOR_COLOR: Record<ViewerArticle['author'], string> = {
  lila:  'text-emerald-300 border-emerald-800 bg-emerald-950/40',
  vega:  'text-blue-300 border-blue-800 bg-blue-950/40',
  ceelo: 'text-rose-300 border-rose-800 bg-rose-950/40',
}

export default function ViewerPage() {
  const [mode, setMode] = useState<Mode>('edges')
  const router = useRouter()

  const signOut = async () => {
    await fetch('/api/viewer/login', { method: 'DELETE' })
    router.replace('/login')
  }

  return (
    <div className="h-dvh bg-slate-950 max-w-md mx-auto flex flex-col">
      {/* Header */}
      <header className="shrink-0 px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <p className="text-[11px] font-mono text-emerald-400 font-semibold tracking-widest">LILA · VIEWER</p>
          <p className="text-[9px] font-mono text-slate-600">predictions + articles · read-only</p>
        </div>
        <button
          onClick={signOut}
          className="text-[9px] font-mono text-slate-600 border border-slate-800 rounded px-2 py-1 active:bg-slate-900"
        >
          SIGN OUT
        </button>
      </header>

      {/* Mode switch */}
      <div className="shrink-0 flex border-b border-slate-800">
        <ModeTab active={mode === 'edges'}    label="Edges"    onClick={() => setMode('edges')} />
        <ModeTab active={mode === 'articles'} label="Articles" onClick={() => setMode('articles')} />
      </div>

      {/* Body */}
      <main className="flex-1 relative overflow-hidden">
        <EdgesPanel    visible={mode === 'edges'} />
        <ArticlesPanel visible={mode === 'articles'} />
      </main>
    </div>
  )
}

function ModeTab({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-3 text-[11px] font-mono tracking-widest uppercase ${
        active
          ? 'text-emerald-400 border-b-2 border-emerald-500'
          : 'text-slate-600 active:text-slate-400 border-b-2 border-transparent'
      }`}
    >
      {label}
    </button>
  )
}

// ─── Edges panel ────────────────────────────────────────────────────────────

function EdgesPanel({ visible }: { visible: boolean }) {
  const [sport, setSport] = useState<Sport>('NFL')
  const [feed, setFeed] = useState<ViewerEdgeFeed | null>(null)
  const [greenOnly, setGreenOnly] = useState(false)

  useEffect(() => {
    if (!visible) return
    const load = async () => {
      try {
        const res = await fetch(`/api/viewer/edges?sport=${sport}&days=7`)
        if (res.ok) setFeed(await res.json())
      } catch { /* ignore */ }
    }
    load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [visible, sport])

  const filtered = useMemo(() => {
    if (!feed) return [] as Array<{ date: string; items: ViewerGame[] }>
    if (!greenOnly) return feed.byDate
    return feed.byDate
      .map(d => ({ date: d.date, items: d.items.filter(g => g.light === 'green') }))
      .filter(d => d.items.length > 0)
  }, [feed, greenOnly])

  return (
    <div className={`absolute inset-0 overflow-y-auto ${visible ? '' : 'invisible pointer-events-none'}`}>
      <div className="px-4 py-4 space-y-3">
        {/* Sport selector */}
        <div className="flex gap-2">
          {(['NFL', 'NBA', 'MLB'] as Sport[]).map(s => (
            <button
              key={s}
              onClick={() => setSport(s)}
              className={`flex-1 text-[11px] font-mono py-2 rounded-lg border tracking-widest transition-colors ${
                sport === s
                  ? 'bg-rose-950/40 border-rose-800 text-rose-300'
                  : 'border-slate-800 text-slate-500 active:bg-slate-900'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        <button
          onClick={() => setGreenOnly(!greenOnly)}
          className={`w-full text-[10px] font-mono px-3 py-1.5 rounded-lg border tracking-widest ${
            greenOnly
              ? 'bg-emerald-950/40 border-emerald-800 text-emerald-300'
              : 'border-slate-800 text-slate-500 active:bg-slate-900'
          }`}
        >
          ● GREEN ONLY
        </button>

        {feed?.meta && (
          <p className="text-[10px] font-mono text-slate-500">
            {sport} · {feed.meta.green_count} green · {feed.meta.yellow_count} yellow · pred. total ~{feed.meta.avg_total}
          </p>
        )}

        {!feed ? (
          <p className="text-[11px] font-mono text-slate-700 py-6 text-center">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="text-[11px] font-mono text-slate-700 py-6 text-center">
            {greenOnly ? 'No green games right now.' : 'No upcoming games yet.'}
          </p>
        ) : (
          filtered.map(g => (
            <div key={g.date} className="space-y-2">
              <p className="text-[10px] font-mono text-slate-500 tracking-widest pt-2">
                {fmtDateHeader(g.date)} · {g.items.length}
              </p>
              {g.items.map(row => <ViewerGameCard key={row.game_id} row={row} />)}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function ViewerGameCard({ row }: { row: ViewerGame }) {
  const time = new Date(row.kickoff_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const lightColor = row.light === 'green' ? 'bg-emerald-400'
                   : row.light === 'yellow' ? 'bg-amber-400'
                   : 'bg-slate-700'
  const lightBorder = row.light === 'green' ? 'border-emerald-900/60'
                    : row.light === 'yellow' ? 'border-amber-900/40'
                    : 'border-slate-800'
  const cons = row.consensus_home_spread
  const homeIsFavored = cons != null && cons < 0
  const bookFav = cons != null ? (homeIsFavored ? row.home_team : row.away_team) : null
  const bookMag = cons != null ? Math.abs(cons) : null

  const model = row.model_home_spread
  const modelFav = model != null && model !== 0 ? (model < 0 ? row.home_team : row.away_team) : null
  const modelMag = model != null ? Math.abs(model) : null

  const edge = row.edge_points
  const edgeMag = edge != null ? Math.abs(edge).toFixed(1) : null

  return (
    <div className={`rounded-xl border ${lightBorder} bg-slate-950/40 overflow-hidden`}>
      <div className="px-3 pt-3 pb-2 flex items-start gap-2">
        <span className={`w-2.5 h-2.5 rounded-full mt-1.5 shrink-0 ${lightColor}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 text-[12px] font-mono text-slate-100 font-semibold tabular-nums flex-wrap">
            <span>{row.away_team}</span>
            <span className="text-[9px] font-mono text-slate-600">{row.away_record}</span>
            <span className="text-slate-600 mx-1">@</span>
            <span>{row.home_team}</span>
            <span className="text-[9px] font-mono text-slate-600">{row.home_record}</span>
          </div>
          <p className="text-[9px] font-mono text-slate-600 mt-0.5">
            {time}{row.book_count > 0 && <> · {row.book_count} book{row.book_count === 1 ? '' : 's'}</>}
          </p>
        </div>
      </div>
      <div className="px-3 pb-3 pt-1 border-t border-slate-800/60 space-y-2">
        {row.predicted_home_score != null && row.predicted_away_score != null ? (
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[8px] font-mono text-slate-600 tracking-widest w-12 shrink-0">CEELO</span>
            <span className="text-[13px] font-mono font-semibold text-rose-300 tabular-nums">
              {row.away_team} {row.predicted_away_score} — {row.home_team} {row.predicted_home_score}
            </span>
            {modelFav && modelMag != null && (
              <span className="text-[10px] font-mono text-slate-400">({modelFav} by {modelMag.toFixed(1)})</span>
            )}
          </div>
        ) : (
          <p className="text-[10px] font-mono text-slate-600">model not computed yet</p>
        )}

        {cons != null && bookFav && bookMag != null ? (
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[8px] font-mono text-slate-600 tracking-widest w-12 shrink-0">BOOK</span>
            <span className="text-[12px] font-mono text-slate-200 tabular-nums">
              {bookFav} {bookMag === 0 ? 'PK' : `-${bookMag.toFixed(1)}`}
            </span>
            <span className="text-[9px] font-mono text-slate-600">consensus</span>
          </div>
        ) : (
          <p className="text-[10px] font-mono text-slate-600">no live lines</p>
        )}

        {edge != null && row.edge_team && edgeMag != null && (
          <div className="flex items-baseline gap-2 pt-1 border-t border-slate-900/60">
            <span className="text-[8px] font-mono text-slate-600 tracking-widest w-12 shrink-0">EDGE</span>
            <span className={`text-[12px] font-mono font-semibold tabular-nums ${row.light === 'green' ? 'text-emerald-300' : 'text-amber-300'}`}>
              {edge >= 0 ? '+' : '−'}{edgeMag} pt
            </span>
            <span className="text-[10px] font-mono text-slate-400">
              {row.light === 'green'
                ? <>take <span className="text-emerald-300">{row.edge_team}</span></>
                : <>{row.edge_team} edge — within tolerance</>}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Articles panel ─────────────────────────────────────────────────────────

function ArticlesPanel({ visible }: { visible: boolean }) {
  const [articles, setArticles] = useState<ViewerArticle[] | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)

  useEffect(() => {
    if (!visible) return
    const load = async () => {
      try {
        const res = await fetch('/api/viewer/articles')
        if (res.ok) {
          const body = await res.json()
          setArticles(body.articles ?? [])
        }
      } catch { /* ignore */ }
    }
    load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [visible])

  return (
    <div className={`absolute inset-0 overflow-y-auto ${visible ? '' : 'invisible pointer-events-none'}`}>
      <div className="px-4 py-4 space-y-3">
        {!articles ? (
          <p className="text-[11px] font-mono text-slate-700 py-6 text-center">Loading…</p>
        ) : articles.length === 0 ? (
          <p className="text-[11px] font-mono text-slate-700 py-6 text-center">
            No articles published yet.
          </p>
        ) : (
          articles.map(a => {
            const expanded = openId === a.id
            return (
              <div key={a.id} className="border border-slate-800 rounded-xl bg-slate-900 overflow-hidden">
                <button
                  className="w-full p-3 text-left"
                  onClick={() => setOpenId(expanded ? null : a.id)}
                >
                  <div className="flex items-start gap-2">
                    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${AUTHOR_COLOR[a.author]}`}>
                      {a.author.toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] font-mono text-slate-100 font-semibold truncate">{a.title}</p>
                      <p className="text-[9px] font-mono text-slate-600 mt-0.5">
                        {fmtRelative(a.created_ts)} · {a.kind}
                      </p>
                    </div>
                    <span className={`text-slate-600 text-xs font-mono shrink-0 mt-0.5 transition-transform ${expanded ? 'rotate-180' : ''}`}>▾</span>
                  </div>
                </button>
                {expanded && (
                  <div className="border-t border-slate-800 px-3 py-3">
                    <pre className="text-[11px] font-mono text-slate-200 leading-relaxed whitespace-pre-wrap break-words select-text">
                      {a.content}
                    </pre>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ─── helpers ───────────────────────────────────────────────────────────────

function fmtDateHeader(yyyymmdd: string): string {
  const d = new Date(yyyymmdd + 'T12:00:00')
  const today = new Date()
  const diffDays = Math.floor((d.getTime() - today.getTime()) / 86_400_000)
  if (diffDays === 0) return 'TODAY'
  if (diffDays === 1) return 'TOMORROW'
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()
}

function fmtRelative(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24); return `${d}d ago`
}
