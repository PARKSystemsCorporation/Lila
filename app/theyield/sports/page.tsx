// /theyield/sports — the scoreboard. FanDuel-style row layout:
//   league dropdown · tab row · date stepper · book selector
//   then one row per game with: team logos · team + record ·
//   current line · open line · Bets% · Money%.
//
// Data: /api/viewer/scoreboard?sport=&date=. The server packages the
// per-book lines and the line-move-derived Bets%/Money% heuristic. NHL
// renders a "soon" stub.

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  LocalShell,
  IconBasketball, IconFootball, IconBaseball, IconHockey,
} from '@/app/_components/local/chrome'

// ─── Types (mirror /api/viewer/scoreboard) ────────────────────────────────

type Sport = 'NBA' | 'NFL' | 'MLB'
type Market = 'spread' | 'total'

interface LineSnap {
  fanduel_current:   number | null
  fanduel_open:      number | null
  consensus_current: number | null
}

interface MarketDerived {
  // line-move-derived. Both null when we don't have FanDuel open + current.
  bets_pct:  number | null
  money_pct: number | null
  // 'home' / 'away' / 'over' / 'under' — which side is implied "popular"
  popular_side: 'home' | 'away' | 'over' | 'under' | null
}

interface ScoreboardGame {
  game_id: number
  sport: Sport
  home_team: string
  home_abbr: string
  home_record: string
  away_team: string
  away_abbr: string
  away_record: string
  kickoff_at: number
  spread: (LineSnap & MarketDerived) | null
  total:  (LineSnap & MarketDerived) | null
}

interface ScoreboardResponse {
  games: ScoreboardGame[]
  meta: { sport: Sport; date: string; refreshed_ts: number }
}

// ─── Constants ────────────────────────────────────────────────────────────

const LEAGUES: { key: Sport | 'NHL'; label: string; icon: JSX.Element; soon?: boolean }[] = [
  { key: 'NBA', label: 'NBA', icon: <IconBasketball /> },
  { key: 'NFL', label: 'NFL', icon: <IconFootball /> },
  { key: 'MLB', label: 'MLB', icon: <IconBaseball /> },
  { key: 'NHL', label: 'NHL', icon: <IconHockey />, soon: true },
]

const BOOKS = ['Consensus', 'FanDuel'] as const
type Book = typeof BOOKS[number]

// ─── Page ─────────────────────────────────────────────────────────────────

export default function TheYieldSports() {
  const [sport, setSport] = useState<Sport>('NBA')
  const [sportSoon, setSportSoon] = useState<'NHL' | null>(null)
  const [date, setDate] = useState<string>(() => isoDate(new Date()))
  const [book, setBook] = useState<Book>('Consensus')
  const [resp, setResp] = useState<ScoreboardResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [leagueOpen, setLeagueOpen] = useState(false)
  const [bookOpen, setBookOpen] = useState(false)

  const load = useCallback(async () => {
    if (sportSoon) { setResp({ games: [], meta: { sport: 'NBA', date, refreshed_ts: Date.now() } }); setLoading(false); return }
    setLoading(true)
    try {
      const r = await fetch(`/api/viewer/scoreboard?sport=${sport}&date=${date}`, { cache: 'no-store' })
      if (!r.ok) { setResp(null); return }
      setResp(await r.json())
    } catch {
      setResp(null)
    } finally {
      setLoading(false)
    }
  }, [sport, date, sportSoon])

  useEffect(() => {
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [load])

  const games = resp?.games ?? []
  const activeLeague = useMemo(
    () => LEAGUES.find(l => l.key === (sportSoon ?? sport))!,
    [sport, sportSoon]
  )

  const stepDate = (delta: number) => {
    const d = new Date(date + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + delta)
    setDate(isoDate(d))
  }

  return (
    <LocalShell
      title="SCOREBOARD"
      subtitle="Live lines. Real-time edges."
      accent="amber"
      back={{ href: '/theyield', label: 'back to the yield' }}
    >
      {/* League header */}
      <section className="border-b border-amber-500/15 bg-slate-950/40">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-4 flex items-center justify-between gap-3">
          <div className="relative">
            <button
              type="button"
              onClick={() => setLeagueOpen(v => !v)}
              className="flex items-center gap-2 sm:gap-3 border border-amber-500/30 hover:border-amber-300 px-3 py-2 transition-colors"
            >
              <span className="text-amber-300">{activeLeague.icon}</span>
              <span className="font-black tracking-tight text-white text-lg sm:text-xl uppercase">{activeLeague.label}</span>
              <span className="text-amber-400 text-xs">▾</span>
            </button>
            {leagueOpen && (
              <div className="absolute top-full left-0 mt-1 w-44 border border-amber-500/30 bg-[#0a0c14] z-20 shadow-[0_10px_40px_-10px_rgba(0,0,0,0.6)]">
                {LEAGUES.map(l => {
                  const active = (sportSoon ?? sport) === l.key
                  return (
                    <button
                      key={l.key}
                      type="button"
                      disabled={l.soon}
                      onClick={() => {
                        if (l.soon) {
                          setSportSoon('NHL')
                        } else {
                          setSportSoon(null)
                          setSport(l.key as Sport)
                        }
                        setLeagueOpen(false)
                      }}
                      className={[
                        'w-full flex items-center justify-between gap-3 px-3 py-2 text-left transition-colors',
                        l.soon
                          ? 'text-slate-600 cursor-not-allowed'
                          : active
                            ? 'bg-amber-500/10 text-amber-300'
                            : 'text-slate-200 hover:bg-slate-900',
                      ].join(' ')}
                    >
                      <span className="flex items-center gap-2">
                        <span className={l.soon ? 'text-slate-700' : 'text-amber-400'}>{l.icon}</span>
                        <span className="font-mono text-[11px] tracking-[0.32em] uppercase">{l.label}</span>
                      </span>
                      {l.soon && (
                        <span className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-700 border border-slate-800 px-1.5">
                          soon
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 text-slate-500">
            <button type="button" aria-label="search" className="opacity-60 hover:opacity-100 transition-opacity">
              <SearchGlyph />
            </button>
            <button type="button" aria-label="filter" className="opacity-60 hover:opacity-100 transition-opacity">
              <FilterGlyph />
            </button>
          </div>
        </div>
      </section>

      {/* Tab row */}
      <nav className="border-b border-amber-500/15 bg-slate-950/40">
        <div className="mx-auto max-w-7xl px-2 sm:px-8">
          <ul className="flex items-center gap-1 sm:gap-2 overflow-x-auto">
            <TabPill label="Scoreboard" active />
            <TabPill label="Game Lines" disabled />
            <TabPill label="SGPs" disabled />
          </ul>
        </div>
      </nav>

      {/* Date + book strip */}
      <section className="border-b border-amber-500/15">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <StepButton dir="left" onClick={() => stepDate(-1)} />
            <span className="font-mono text-[11px] sm:text-[12px] tracking-[0.32em] uppercase text-white tabular-nums whitespace-nowrap">
              {formatDateLabel(date)}
            </span>
            <StepButton dir="right" onClick={() => stepDate(+1)} />
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => setBookOpen(v => !v)}
              className="flex items-center gap-2 border border-amber-500/30 hover:border-amber-300 px-3 py-1.5 transition-colors"
            >
              <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-amber-300">{book}</span>
              <span className="text-amber-400 text-xs">▾</span>
            </button>
            {bookOpen && (
              <div className="absolute top-full right-0 mt-1 w-32 border border-amber-500/30 bg-[#0a0c14] z-20">
                {BOOKS.map(b => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => { setBook(b); setBookOpen(false) }}
                    className={[
                      'w-full px-3 py-2 text-left font-mono text-[10px] tracking-[0.32em] uppercase transition-colors',
                      b === book ? 'bg-amber-500/10 text-amber-300' : 'text-slate-200 hover:bg-slate-900',
                    ].join(' ')}
                  >
                    {b}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Scheduled list */}
      {sportSoon ? (
        <SoonPanel sport={sportSoon} />
      ) : (
        <section className="mx-auto max-w-7xl px-3 sm:px-6 py-6 sm:py-8">
          <div className="flex items-center gap-2 px-2 mb-3">
            <span className="text-amber-400 text-xs">▾</span>
            <h2 className="font-mono text-[10px] sm:text-[11px] tracking-[0.32em] uppercase text-slate-300">
              Scheduled · {games.length}
            </h2>
          </div>

          <div className="border-2 border-amber-500/15 bg-slate-950/60 divide-y divide-amber-500/10">
            <ColumnLabels />
            {loading && games.length === 0 ? (
              Array.from({ length: 4 }).map((_, i) => <GameRowSkeleton key={i} />)
            ) : games.length === 0 ? (
              <div className="px-5 py-10 text-center font-mono text-[11px] tracking-[0.32em] uppercase text-slate-600">
                No games on the board for {formatDateLabel(date).toLowerCase()}.
              </div>
            ) : (
              games.map(g => <GameRow key={g.game_id} game={g} book={book} />)
            )}
          </div>
        </section>
      )}
    </LocalShell>
  )
}

// ─── Subcomponents ────────────────────────────────────────────────────────

function TabPill({ label, active, disabled }: { label: string; active?: boolean; disabled?: boolean }) {
  return (
    <li className="shrink-0">
      <button
        type="button"
        disabled={disabled}
        className={[
          'px-3 sm:px-4 py-3 font-mono text-[10px] sm:text-[11px] tracking-[0.32em] uppercase border-b-2 transition-colors whitespace-nowrap',
          active
            ? 'border-amber-300 text-amber-300'
            : disabled
              ? 'border-transparent text-slate-700 cursor-not-allowed'
              : 'border-transparent text-slate-400 hover:text-amber-300',
        ].join(' ')}
      >
        {label}
      </button>
    </li>
  )
}

function StepButton({ dir, onClick }: { dir: 'left' | 'right'; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center border border-amber-500/30 hover:border-amber-300 text-amber-300 transition-colors"
      aria-label={dir === 'left' ? 'previous day' : 'next day'}
    >
      {dir === 'left' ? '‹' : '›'}
    </button>
  )
}

function ColumnLabels() {
  return (
    <div className="hidden sm:grid grid-cols-[minmax(0,1fr)_repeat(4,90px)] gap-3 px-4 py-2 font-mono text-[9px] tracking-[0.32em] uppercase text-slate-600">
      <span />
      <span className="text-right">Line</span>
      <span className="text-right">Open</span>
      <span className="text-right">Bets %</span>
      <span className="text-right">Money %</span>
    </div>
  )
}

function GameRow({ game, book }: { game: ScoreboardGame; book: Book }) {
  // Render two market lines: spread (favorite line) and total (over).
  // Choose which column powers the displayed value based on the book selector.
  const ko = new Date(game.kickoff_at)
  const koLabel = ko.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

  // Identify favorite for spread. Negative home line → home is favored.
  const homeLine = game.spread?.[bookKey(book, 'current')]
  const homeOpen = game.spread?.[bookKey(book, 'open')]
  const homeFavored = (homeLine ?? 0) < 0
  const favTeam = homeFavored ? { abbr: game.home_abbr, name: game.home_team, record: game.home_record }
                              : { abbr: game.away_abbr, name: game.away_team, record: game.away_record }
  const dogTeam  = homeFavored ? { abbr: game.away_abbr, name: game.away_team, record: game.away_record }
                               : { abbr: game.home_abbr, name: game.home_team, record: game.home_record }

  // Spread numbers shown on the favorite row.
  const favSpread = homeLine != null ? (homeFavored ? homeLine : -homeLine) : null
  const favSpreadOpen = homeOpen != null ? (homeFavored ? homeOpen : -homeOpen) : null

  // Total line + open shown on the underdog row (visual matches screenshot).
  const totalCurrent = game.total?.[bookKey(book, 'current')] ?? null
  const totalOpen    = game.total?.[bookKey(book, 'open')]    ?? null

  return (
    <div className="grid grid-cols-[1fr_auto] gap-3 px-3 sm:px-4 py-3 hover:bg-slate-900/40 transition-colors">
      <div className="min-w-0 space-y-2">
        <TeamLine
          team={favTeam}
          metaLeft={koLabel}
          current={favSpread != null ? formatSpread(favSpread) : '—'}
          open={favSpreadOpen != null ? formatSpread(favSpreadOpen) : '—'}
          betsPct={pctLabel(game.spread?.bets_pct, game.spread?.popular_side, favTeam.abbr, dogTeam.abbr)}
          moneyPct={pctLabel(game.spread?.money_pct, game.spread?.popular_side, favTeam.abbr, dogTeam.abbr)}
        />
        <TeamLine
          team={dogTeam}
          metaLeft="total"
          current={totalCurrent != null ? totalCurrent.toFixed(1) : '—'}
          open={totalOpen != null ? totalOpen.toFixed(1) : '—'}
          betsPct={pctLabel(game.total?.bets_pct, game.total?.popular_side, 'Ov', 'Un')}
          moneyPct={pctLabel(game.total?.money_pct, game.total?.popular_side, 'Ov', 'Un')}
        />
      </div>
      <div className="flex flex-col items-end gap-2 self-stretch justify-between">
        <button
          type="button"
          aria-label="track game"
          className="text-slate-600 hover:text-amber-300 transition-colors"
        >
          <BellGlyph />
        </button>
        <button
          type="button"
          className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-500 hover:text-amber-300 border border-slate-800 hover:border-amber-500/40 px-2 py-1 transition-colors whitespace-nowrap"
        >
          view more
        </button>
      </div>
    </div>
  )
}

function TeamLine({
  team, metaLeft, current, open, betsPct, moneyPct,
}: {
  team: { abbr: string; name: string; record: string }
  metaLeft: string
  current: string
  open: string
  betsPct: string
  moneyPct: string
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_repeat(4,minmax(48px,90px))] gap-2 sm:gap-3 items-center">
      <div className="flex items-center gap-2 min-w-0">
        <TeamLogo abbr={team.abbr} />
        <div className="min-w-0">
          <div className="text-white font-bold text-sm sm:text-base truncate">
            <span className="tabular-nums">{team.abbr}</span>
            <span className="ml-2 font-mono text-[10px] tracking-[0.2em] text-slate-500 uppercase">{team.record}</span>
          </div>
          <div className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-600">
            {metaLeft}
          </div>
        </div>
      </div>
      <div className="text-right font-mono text-sm sm:text-base text-white tabular-nums">{current}</div>
      <div className="text-right font-mono text-sm sm:text-base text-slate-400 tabular-nums">{open}</div>
      <div className="text-right font-mono text-[11px] text-amber-300 tabular-nums">{betsPct}</div>
      <div className="text-right font-mono text-[11px] text-amber-300 tabular-nums">{moneyPct}</div>
    </div>
  )
}

function TeamLogo({ abbr }: { abbr: string }) {
  return (
    <span className="w-7 h-7 sm:w-8 sm:h-8 shrink-0 border border-slate-700 bg-slate-900 flex items-center justify-center font-mono text-[9px] tracking-[0.1em] uppercase text-slate-300">
      {abbr.slice(0, 3)}
    </span>
  )
}

function GameRowSkeleton() {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-3 px-3 sm:px-4 py-3">
      <div className="space-y-2 min-w-0">
        {[0, 1].map(i => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_repeat(4,minmax(48px,90px))] gap-2 sm:gap-3 items-center">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 sm:w-8 sm:h-8 bg-slate-900 animate-pulse" />
              <div className="h-4 w-24 bg-slate-900 animate-pulse" />
            </div>
            <div className="h-4 bg-slate-900 animate-pulse ml-auto w-10" />
            <div className="h-4 bg-slate-900 animate-pulse ml-auto w-10" />
            <div className="h-4 bg-slate-900 animate-pulse ml-auto w-10" />
            <div className="h-4 bg-slate-900 animate-pulse ml-auto w-10" />
          </div>
        ))}
      </div>
      <div className="w-12 bg-slate-900/40 animate-pulse" />
    </div>
  )
}

function SoonPanel({ sport }: { sport: 'NHL' }) {
  return (
    <section className="mx-auto max-w-3xl px-5 sm:px-8 py-20 sm:py-28 text-center">
      <div className="inline-flex items-center justify-center mb-6 text-amber-500/40">
        <IconHockey />
      </div>
      <h2 className="text-[clamp(1.6rem,5vw,2.4rem)] font-black tracking-tight uppercase text-white">
        {sport} · <span className="text-amber-400">soon</span>
      </h2>
      <p className="mt-4 max-w-md mx-auto text-sm text-slate-500 leading-relaxed">
        We&rsquo;ll wire {sport} once the model has enough data to call edges with conviction.
      </p>
    </section>
  )
}

// ─── Glyphs ───────────────────────────────────────────────────────────────

function SearchGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

function FilterGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 5h16M7 12h10M10 19h4" />
    </svg>
  )
}

function BellGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 8a6 6 0 0 1 12 0v4l2 3H4l2-3z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </svg>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatDateLabel(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function formatSpread(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const sign = n > 0 ? '+' : ''
  return `${sign}${n.toFixed(1)}`
}

function pctLabel(
  pct: number | null | undefined,
  side: 'home' | 'away' | 'over' | 'under' | null | undefined,
  favAbbr: string,
  dogAbbr: string,
): string {
  if (pct == null) return '—'
  const label =
    side === 'home' ? favAbbr
  : side === 'away' ? dogAbbr
  : side === 'over' ? 'Ov'
  : side === 'under' ? 'Un'
  : ''
  return label ? `${pct}% ${label}` : `${pct}%`
}

// Map the book selector + which column to the corresponding LineSnap field.
function bookKey(book: Book, kind: 'current' | 'open'): keyof LineSnap {
  if (book === 'FanDuel') return kind === 'open' ? 'fanduel_open' : 'fanduel_current'
  // Consensus has no open snapshot in this view — fall back to FanDuel open.
  return kind === 'open' ? 'fanduel_open' : 'consensus_current'
}
