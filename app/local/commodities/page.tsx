// /local/commodities — futures dashboard mirroring /local/sports's structure.
// No live feed yet: prices, edges, sparklines are mocked and every cell
// carries an "//awaiting feed" tag so it's obvious this is placeholder data.
// Real wiring lands when we hook up a commodities price service.

'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import {
  LocalShell,
  IconGold, IconWheat, IconFlame, IconBull, IconBarrel, IconCoffee, IconPlay,
} from '@/app/_components/local/chrome'
import { CONTRACTS, CATEGORY_META, COMMODITY_HREF, type Category, type Contract } from '@/lib/commodities'

// ─── Types ────────────────────────────────────────────────────────────────

interface ViewerArticle {
  id: number
  title: string
  content: string
  author: 'lila' | 'vega' | 'ceelo'
  kind: string
  created_ts: number
}

type Tab = 'OVERVIEW' | 'ENERGY' | 'METALS' | 'AGRICULTURE' | 'LIVESTOCK'
const TABS: Tab[] = ['OVERVIEW', 'ENERGY', 'METALS', 'AGRICULTURE', 'LIVESTOCK']

const TAB_TO_CATEGORIES: Record<Exclude<Tab, 'OVERVIEW'>, Category[]> = {
  ENERGY:      ['energy'],
  METALS:      ['metals'],
  AGRICULTURE: ['grains', 'softs'],
  LIVESTOCK:   ['livestock'],
}

// ─── Mocked market state ──────────────────────────────────────────────────
// Until a live feed lands, every numeric cell here is a static, deterministic
// mock. Tagged with `awaiting feed` so it's obvious in the UI.

interface MockQuote {
  ticker: string                // e.g. CLM4
  price: number
  changePct: number             // signed %
  edgePct: number               // 0..100
  direction: 'bullish' | 'bearish'
  spark: number[]               // 12 normalized 0..1 points
}

// Pinned mock numbers so SSR + client render the same thing (no hydration thrash).
const MOCKS: Record<string, MockQuote> = {
  CL: { ticker: 'CLM4', price: 78.42,  changePct:  1.71, edgePct: 81, direction: 'bullish', spark: [.2,.3,.25,.4,.55,.45,.6,.7,.65,.75,.82,.9] },
  NG: { ticker: 'NGM4', price:  2.60,  changePct:  3.17, edgePct: 72, direction: 'bullish', spark: [.5,.45,.55,.5,.6,.7,.65,.6,.75,.72,.78,.85] },
  HO: { ticker: 'HOM4', price:  2.41,  changePct:  0.46, edgePct: 58, direction: 'bullish', spark: [.4,.42,.45,.43,.5,.48,.55,.52,.58,.6,.62,.65] },
  GC: { ticker: 'GCM4', price: 2353.6, changePct:  0.79, edgePct: 76, direction: 'bullish', spark: [.35,.4,.5,.45,.55,.6,.58,.7,.68,.75,.8,.85] },
  SI: { ticker: 'SIN4', price: 28.10,  changePct:  1.12, edgePct: 67, direction: 'bullish', spark: [.4,.5,.45,.55,.6,.55,.65,.6,.7,.72,.74,.78] },
  HG: { ticker: 'HGM4', price:  4.62,  changePct:  1.32, edgePct: 63, direction: 'bullish', spark: [.3,.4,.45,.42,.5,.55,.5,.6,.62,.65,.7,.72] },
  ZC: { ticker: 'ZCM4', price:  4.48,  changePct: -0.88, edgePct: 64, direction: 'bearish', spark: [.7,.65,.6,.55,.5,.55,.45,.5,.4,.42,.38,.35] },
  ZW: { ticker: 'ZWN4', price:  6.14,  changePct:  0.21, edgePct: 51, direction: 'bullish', spark: [.45,.5,.48,.55,.5,.6,.55,.62,.6,.65,.66,.7] },
  ZS: { ticker: 'ZSN4', price: 11.97,  changePct: -0.34, edgePct: 47, direction: 'bearish', spark: [.6,.58,.55,.6,.5,.55,.5,.48,.5,.45,.46,.43] },
  KC: { ticker: 'KCN4', price:  2.21,  changePct:  2.05, edgePct: 69, direction: 'bullish', spark: [.3,.35,.45,.5,.55,.5,.6,.65,.7,.72,.78,.85] },
  CC: { ticker: 'CCN4', price: 8821,   changePct:  4.10, edgePct: 74, direction: 'bullish', spark: [.2,.25,.35,.4,.5,.55,.65,.6,.7,.78,.85,.92] },
  CT: { ticker: 'CTN4', price:  0.78,  changePct: -1.20, edgePct: 53, direction: 'bearish', spark: [.7,.65,.6,.65,.55,.5,.52,.45,.5,.42,.4,.38] },
  LE: { ticker: 'LEM4', price:  1.78,  changePct:  0.31, edgePct: 56, direction: 'bullish', spark: [.5,.52,.55,.53,.58,.6,.62,.6,.65,.64,.68,.7] },
  GF: { ticker: 'GFK4', price:  2.52,  changePct: -0.18, edgePct: 49, direction: 'bearish', spark: [.55,.52,.55,.5,.52,.48,.5,.45,.5,.47,.46,.44] },
  HE: { ticker: 'HEM4', price:  1.02,  changePct:  0.87, edgePct: 52, direction: 'bullish', spark: [.4,.42,.45,.5,.48,.52,.55,.53,.58,.6,.62,.65] },
}

// Pick an icon by root.
const ICON_BY_ROOT: Record<string, JSX.Element> = {
  CL: <IconBarrel />,  NG: <IconFlame />,    HO: <IconBarrel />,
  GC: <IconGold />,    SI: <IconGold />,     HG: <IconGold />,
  ZC: <IconWheat />,   ZW: <IconWheat />,    ZS: <IconWheat />,
  KC: <IconCoffee />,  CC: <IconCoffee />,   CT: <IconWheat />,
  LE: <IconBull />,    GF: <IconBull />,     HE: <IconBull />,
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function LocalCommodities() {
  const [tab, setTab] = useState<Tab>('OVERVIEW')
  const [article, setArticle] = useState<ViewerArticle | null>(null)
  const [articleLoaded, setArticleLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    fetch('/api/viewer/articles', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!alive) return
        const arts: ViewerArticle[] = d?.articles ?? []
        setArticle(arts.sort((a, b) => b.created_ts - a.created_ts)[0] ?? null)
        setArticleLoaded(true)
      })
      .catch(() => alive && setArticleLoaded(true))
    return () => { alive = false }
  }, [])

  const filteredContracts = useMemo(() => {
    if (tab === 'OVERVIEW') return CONTRACTS
    const cats = TAB_TO_CATEGORIES[tab]
    return CONTRACTS.filter(c => cats.includes(c.category))
  }, [tab])

  const top3 = useMemo(() => {
    const headline = filteredContracts.filter(c => c.headline)
    const pool = headline.length >= 3 ? headline : filteredContracts
    return pool
      .map(c => ({ contract: c, quote: MOCKS[c.root] }))
      .filter((row): row is { contract: Contract; quote: MockQuote } => !!row.quote)
      .sort((a, b) => b.quote.edgePct - a.quote.edgePct)
      .slice(0, 3)
  }, [filteredContracts])

  const top5 = useMemo(() => {
    return filteredContracts
      .map(c => ({ contract: c, quote: MOCKS[c.root] }))
      .filter((row): row is { contract: Contract; quote: MockQuote } => !!row.quote)
      .sort((a, b) => b.quote.edgePct - a.quote.edgePct)
      .slice(0, 5)
  }, [filteredContracts])

  return (
    <LocalShell
      title="COMMODITIES"
      subtitle="Track the markets. Spot the moves."
      accent="orange"
      back={{ href: '/local', label: 'back to markets' }}
      hero={<HeroPump />}
    >
      {/* Tabs */}
      <nav className="border-b border-amber-500/15 bg-slate-950/40">
        <div className="mx-auto max-w-7xl px-2 sm:px-8 overflow-x-auto">
          <ul className="flex items-center gap-1 sm:gap-2 min-w-min">
            {TABS.map(t => {
              const active = t === tab
              return (
                <li key={t} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => setTab(t)}
                    className={[
                      'px-3 sm:px-4 py-3 font-mono text-[10px] sm:text-[11px] tracking-[0.32em] uppercase border-b-2 transition-colors',
                      active
                        ? 'border-orange-300 text-orange-300'
                        : 'border-transparent text-slate-500 hover:text-orange-300',
                    ].join(' ')}
                  >
                    {t}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </nav>

      {/* awaiting-feed banner */}
      <div className="border-b border-amber-500/10 bg-amber-500/[0.03]">
        <div className="mx-auto max-w-7xl px-5 sm:px-8 py-3 flex items-center gap-3 font-mono text-[10px] tracking-[0.25em] uppercase text-amber-500/80">
          <span className="inline-flex w-2 h-2 rounded-full bg-amber-500/60 animate-pulse" />
          <span>price feed offline · numbers are placeholders until the wire goes live</span>
        </div>
      </div>

      {/* BIGGEST EDGE TOP 3 */}
      <section className="mx-auto max-w-7xl px-5 sm:px-8 pt-10 sm:pt-14">
        <SectionHead title="biggest edge" badge="top 3 ⚡" />
        <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
          {top3.length === 0
            ? <EmptyCard span={3} body={`no headline contracts in ${tab.toLowerCase()}`} />
            : top3.map((row, i) => (
                <FuturesEdgeCard key={row.contract.root} rank={i + 1} contract={row.contract} quote={row.quote} icon={ICON_BY_ROOT[row.contract.root]} />
              ))}
        </div>
      </section>

      {/* TOP 5 FUTURES */}
      <section className="mx-auto max-w-7xl px-5 sm:px-8 pt-10 sm:pt-14">
        <SectionHead title="live futures" badge="top 5" live />
        <div className="mt-5 border-2 border-orange-500/15 bg-slate-950/60 divide-y divide-orange-500/10">
          {top5.length === 0 && (
            <div className="px-5 py-8 text-center font-mono text-[11px] tracking-[0.25em] uppercase text-slate-600">
              nothing on the board for {tab.toLowerCase()}.
            </div>
          )}
          {top5.map((row, i) => (
            <FuturesRow key={row.contract.root} rank={i + 1} contract={row.contract} quote={row.quote} icon={ICON_BY_ROOT[row.contract.root]} />
          ))}
        </div>
      </section>

      {/* CATEGORY meta belt — real metadata from CATEGORY_META */}
      <section className="mx-auto max-w-7xl px-5 sm:px-8 pt-10 sm:pt-14">
        <SectionHead title="categories" />
        <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4">
          {(['energy', 'metals', 'grains', 'softs', 'livestock'] as Category[]).map(cat => {
            const meta = CATEGORY_META[cat]
            return (
              <Link
                key={cat}
                href={`/commodities#${cat}`}
                className="group block border-2 border-orange-500/20 hover:border-orange-300 bg-slate-950/70 p-4 sm:p-5 transition-colors"
              >
                <div className="font-mono text-[10px] tracking-[0.32em] uppercase text-orange-300">{meta.label}</div>
                <div className="mt-1 text-xs sm:text-sm text-slate-400 leading-relaxed">{meta.blurb}</div>
                <div className="mt-3 font-mono text-[9px] tracking-[0.32em] uppercase text-slate-600 group-hover:text-orange-300 transition-colors">
                  headline · {meta.headline} →
                </div>
              </Link>
            )
          })}
        </div>
      </section>

      {/* THE BIGGEST STORY */}
      <section className="mx-auto max-w-7xl px-5 sm:px-8 pt-10 sm:pt-14 pb-14">
        <SectionHead title="the biggest story" />
        <div className="mt-5">
          {!articleLoaded
            ? <StorySkeleton />
            : article
              ? <StoryCard article={article} />
              : <EmptyStory />}
        </div>
      </section>
    </LocalShell>
  )
}

// ─── Section bits ─────────────────────────────────────────────────────────

function SectionHead({ title, badge, live }: { title: string; badge?: string; live?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <div className="flex items-baseline gap-3">
        <h2 className="font-mono text-[11px] sm:text-[12px] tracking-[0.45em] uppercase text-white">{title}</h2>
        {badge && (
          <span className="font-mono text-[9px] tracking-[0.32em] uppercase text-orange-400">
            {live && <span className="inline-flex items-center gap-1.5 mr-2"><span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse" /><span>live</span></span>}
            {badge}
          </span>
        )}
      </div>
      <Link
        href="/commodities"
        className="font-mono text-[9px] sm:text-[10px] tracking-[0.32em] uppercase text-orange-400/80 hover:text-orange-300 transition-colors"
      >
        view all →
      </Link>
    </div>
  )
}

function HeroPump() {
  return (
    <svg viewBox="0 0 220 150" width="220" height="150" className="text-orange-500/30" aria-hidden>
      <defs>
        <radialGradient id="hero-comm-glow" cx="50%" cy="50%">
          <stop offset="0%" stopColor="#fb923c" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#fb923c" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="130" cy="75" r="70" fill="url(#hero-comm-glow)" />
      <g fill="none" stroke="currentColor" strokeWidth="0.6">
        <circle cx="130" cy="75" r="56" />
        <circle cx="130" cy="75" r="36" />
      </g>
      {/* candle ticks */}
      <g stroke="#fb923c" strokeWidth="2" fill="none">
        <path d="M30 110V60M30 100h-4M30 100h4" />
        <path d="M50 110V70M50 100h-4M50 100h4" />
        <path d="M70 110V55M70 95h-4M70 95h4" />
        <path d="M90 110V65M90 92h-4M90 92h4" />
      </g>
      {/* pumpjack abstract */}
      <g fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M150 110h60M160 110v-20l30-12 14 8v24M180 90l12-6 8 5" />
        <path d="M180 110v-15M196 110v-15" />
      </g>
    </svg>
  )
}

// ─── Cards & rows ─────────────────────────────────────────────────────────

function FuturesEdgeCard({ rank, contract, quote, icon }: { rank: number; contract: Contract; quote: MockQuote; icon: JSX.Element }) {
  const tone = contract.tone === 'amber'
    ? { txt: 'text-amber-300',  border: 'border-amber-500/40 hover:border-amber-300',   glow: 'hover:shadow-[0_0_60px_-15px_rgba(245,158,11,0.55)]' }
    : contract.tone === 'orange'
      ? { txt: 'text-orange-300', border: 'border-orange-500/40 hover:border-orange-300', glow: 'hover:shadow-[0_0_60px_-15px_rgba(251,146,60,0.55)]' }
      : { txt: 'text-red-300',    border: 'border-red-500/40 hover:border-red-300',       glow: 'hover:shadow-[0_0_60px_-15px_rgba(239,68,68,0.55)]'  }

  return (
    <Link
      href={COMMODITY_HREF(contract.root)}
      className={`group relative block border-2 ${tone.border} bg-slate-950/70 p-5 sm:p-6 transition-all duration-300 hover:-translate-y-0.5 ${tone.glow}`}
    >
      <AwaitingTag />

      <div className="flex items-baseline justify-between mb-4">
        <span className={`font-mono text-2xl font-black tabular-nums ${tone.txt}`}>{String(rank).padStart(2, '0')}</span>
        <div className="text-right">
          <div className="font-mono text-[10px] tracking-[0.32em] uppercase text-white">{contract.name}</div>
          <div className="font-mono text-[10px] tracking-[0.32em] uppercase text-slate-500">{quote.ticker}</div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4">
        <span className={tone.txt}>{icon}</span>
        <Sparkline points={quote.spark} stroke="#34d399" />
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <div>
          <div className="font-mono text-[10px] tracking-[0.32em] uppercase text-slate-600">price</div>
          <div className="mt-1 text-white tabular-nums text-base font-bold">${quote.price.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[10px] tracking-[0.32em] uppercase text-slate-600">edge</div>
          <div className={`mt-1 text-2xl font-black tabular-nums tracking-tight ${tone.txt}`}>{quote.edgePct}%</div>
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between font-mono text-[10px] tracking-[0.32em] uppercase">
        <span className="text-slate-600">direction</span>
        <span className={quote.direction === 'bullish' ? 'text-emerald-400' : 'text-rose-400'}>
          {quote.direction === 'bullish' ? '↑ bullish' : '↓ bearish'}
        </span>
      </div>
    </Link>
  )
}

function FuturesRow({ rank, contract, quote, icon }: { rank: number; contract: Contract; quote: MockQuote; icon: JSX.Element }) {
  const up = quote.changePct >= 0
  return (
    <Link
      href={COMMODITY_HREF(contract.root)}
      className="group grid grid-cols-[auto_auto_1.5fr_1fr_1fr_auto_auto] sm:grid-cols-[auto_auto_2fr_1fr_1.2fr_1fr_auto] items-center gap-3 sm:gap-5 px-4 sm:px-5 py-3 sm:py-4 hover:bg-slate-900/60 transition-colors"
    >
      <span className="font-mono text-lg sm:text-xl font-black text-orange-300 tabular-nums w-7">
        {String(rank).padStart(2, '0')}
      </span>

      <span className="w-9 h-9 rounded-full border border-slate-800 flex items-center justify-center text-slate-400">
        {icon}
      </span>

      <div className="min-w-0">
        <div className="font-bold text-sm sm:text-base text-white truncate">{contract.name}</div>
        <div className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-500">{quote.ticker}</div>
      </div>

      <div className="hidden sm:block">
        <Sparkline points={quote.spark} stroke={up ? '#34d399' : '#fb7185'} compact />
      </div>

      <div className="text-right font-mono">
        <div className="text-white tabular-nums text-sm font-bold">${quote.price.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
        <div className={`tabular-nums text-[11px] ${up ? 'text-emerald-400' : 'text-rose-400'}`}>
          {up ? '+' : ''}{quote.changePct.toFixed(2)}%
        </div>
      </div>

      <div className="font-mono text-right">
        <div className="text-[9px] tracking-[0.32em] uppercase text-slate-700">edge</div>
        <div className="tabular-nums text-lg font-black text-orange-300">{quote.edgePct}%</div>
      </div>

      <span className="text-slate-700 group-hover:text-orange-300 transition-colors border border-slate-800 group-hover:border-orange-500/40 px-2 py-1">
        <IconPlay />
      </span>
    </Link>
  )
}

function Sparkline({ points, stroke, compact = false }: { points: number[]; stroke: string; compact?: boolean }) {
  const W = compact ? 110 : 140
  const H = compact ? 28 : 44
  const path = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * W
      const y = H - p * H
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="overflow-visible">
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function AwaitingTag() {
  return (
    <span className="absolute top-2 right-2 font-mono text-[8px] tracking-[0.25em] uppercase text-slate-700 border border-slate-800 px-1.5 py-[1px]">
      // awaiting feed
    </span>
  )
}

function StoryCard({ article }: { article: ViewerArticle }) {
  const excerpt = excerptOf(article.content, 180)
  const when = new Date(article.created_ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return (
    <Link
      href="/viewer"
      className="group block border-2 border-orange-500/30 hover:border-orange-300 bg-slate-950/70 transition-colors"
    >
      <div className="relative overflow-hidden px-5 sm:px-8 py-8 sm:py-12">
        <div
          className="absolute inset-0 -z-10 opacity-40"
          style={{
            background: 'radial-gradient(ellipse at 70% 50%, rgba(251,146,60,0.18), transparent 60%)',
          }}
        />
        <div className="flex items-center gap-3 mb-4">
          <span className="bg-orange-400 text-black font-mono text-[10px] tracking-[0.32em] uppercase px-2 py-1">breaking</span>
          <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-orange-500/60">{article.author} · {when}</span>
        </div>
        <h3 className="text-[clamp(1.4rem,3.5vw,2.2rem)] font-black tracking-tight uppercase text-white leading-[1.05] max-w-3xl">
          {article.title}
        </h3>
        <p className="mt-3 max-w-2xl text-sm text-slate-400 leading-relaxed">{excerpt}</p>
        <div className="mt-5 font-mono text-[10px] tracking-[0.32em] uppercase text-orange-400 group-hover:text-orange-300">
          read the dispatch →
        </div>
      </div>
    </Link>
  )
}

function StorySkeleton() {
  return (
    <div className="border-2 border-orange-500/10 bg-slate-950/40 px-5 sm:px-8 py-10">
      <div className="h-4 w-24 bg-slate-900 animate-pulse mb-4" />
      <div className="h-6 w-2/3 bg-slate-900 animate-pulse mb-2" />
      <div className="h-4 w-1/2 bg-slate-900 animate-pulse" />
    </div>
  )
}

function EmptyStory() {
  return (
    <div className="border-2 border-dashed border-orange-500/20 bg-slate-950/40 px-5 sm:px-8 py-10 text-center">
      <p className="font-mono text-[11px] tracking-[0.32em] uppercase text-slate-500">
        no commodity dispatch yet — playbook desk is open
      </p>
      <Link href="/commodities" className="mt-4 inline-block font-mono text-[10px] tracking-[0.32em] uppercase text-orange-400 hover:text-orange-300 transition-colors">
        open the desk →
      </Link>
    </div>
  )
}

function EmptyCard({ span, body }: { span: number; body: string }) {
  return (
    <div
      className="border-2 border-dashed border-orange-500/20 bg-slate-950/40 px-5 py-10 text-center font-mono text-[11px] tracking-[0.25em] uppercase text-slate-500"
      style={{ gridColumn: `span ${span} / span ${span}` }}
    >
      {body}
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function excerptOf(content: string, max = 200): string {
  const stripped = content
    .replace(/^#.+$/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[*_`>#-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (stripped.length <= max) return stripped
  return stripped.slice(0, max).replace(/\s+\S*$/, '') + '…'
}
