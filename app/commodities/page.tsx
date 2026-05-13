'use client'

// Commodities landing. Static data only in v1: 5 desks, 5 headline playbooks,
// 15-row roster. Mirrors /sports chrome — sticky header, hero, tile grid,
// playbook grid, roster table, footer. Default tone is orange; amber grid
// wash kept to match the rest of the site.

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import {
  CONTRACTS,
  CATEGORY_META,
  PLAYBOOKS,
  COMMODITY_HREF,
  type Category,
  type Contract,
} from '@/lib/commodities'
import { TONE } from '@/app/_components/strategy/tone'

const HEADLINE_ROOTS = ['CL', 'GC', 'ZC', 'KC', 'LE'] as const
type HeadlineRoot = typeof HEADLINE_ROOTS[number]

export default function CommoditiesLanding() {
  return (
    <main className="min-h-dvh w-full bg-[#0a0c14] text-slate-100 selection:bg-orange-500/30 selection:text-orange-100">
      <div
        className="pointer-events-none fixed inset-0 -z-10 opacity-40"
        style={{
          backgroundImage:
            'linear-gradient(rgba(245,158,11,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(245,158,11,0.06) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />

      <header className="sticky top-0 z-30 border-b-2 border-orange-500/20 bg-[#0a0c14]/85 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-3 flex items-center justify-between">
          <Link href="/" className="group flex items-center gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse" />
            <span className="font-mono text-[10px] tracking-[0.32em] text-orange-500/80 uppercase group-hover:text-orange-300 transition-colors">
              ▓ park · commodities
            </span>
          </Link>
          <Link href="/" className="font-mono text-[10px] tracking-[0.32em] text-slate-500 hover:text-orange-300 uppercase transition-colors">
            ← thepark.world
          </Link>
        </div>
      </header>

      <section className="relative border-b-2 border-orange-500/20 overflow-hidden">
        <div
          className="absolute inset-0 -z-10 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse at 30% 20%, rgba(251,146,60,0.10), transparent 55%), radial-gradient(ellipse at 70% 80%, rgba(245,158,11,0.06), transparent 55%)',
          }}
        />
        <div className="mx-auto max-w-7xl px-4 sm:px-8 pt-10 sm:pt-16 pb-10 sm:pb-16">
          <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-orange-500/80 uppercase">
            ▌▌▌ futures, full markdown
          </p>
          <h1 className="mt-3 text-[clamp(2.2rem,7vw,4.4rem)] font-black tracking-tight leading-[0.92] uppercase">
            <span className="text-orange-400">FUTURES</span>
            <span className="text-slate-500">, written down.</span>
          </h1>
          <p className="mt-5 max-w-2xl text-sm sm:text-base text-slate-400 leading-relaxed">
            Energy, metals, grains, softs, livestock. The desk reads the curve — you get the markdown.
          </p>
        </div>
      </section>

      <CategoriesSection />
      <PlaybookSection />
      <RosterSection />

      <footer className="bg-slate-950/40">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-7 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <Link
            href="/"
            className="group flex items-center gap-3 font-mono text-[11px] tracking-[0.32em] text-orange-500 uppercase hover:text-orange-300 transition-colors"
          >
            <span className="text-2xl leading-none transition-transform group-hover:-translate-x-0.5">←</span>
            thepark.world
          </Link>
          <span className="font-mono text-[9px] tracking-[0.3em] text-slate-700 uppercase">
            autonomous · commodities desk · v1
          </span>
        </div>
      </footer>
    </main>
  )
}

function CategoriesSection() {
  const categories = Object.keys(CATEGORY_META) as Category[]

  return (
    <section className="border-b-2 border-orange-500/20">
      <div className="mx-auto max-w-7xl px-4 sm:px-8 py-10 sm:py-14">
        <div className="flex items-baseline justify-between gap-4 mb-5 sm:mb-8">
          <div>
            <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-orange-500/80 uppercase">
              ▌▌▌ five desks
            </p>
            <h2 className="mt-2 text-[clamp(1.6rem,5vw,3rem)] font-black tracking-tight uppercase text-white">
              the <span className="text-orange-400">floor</span>.
            </h2>
          </div>
          <p className="hidden sm:block font-mono text-[10px] tracking-[0.3em] text-slate-500 uppercase max-w-[16rem] text-right">
            five categories<br />fifteen contracts
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-4">
          {categories.map((cat, i) => <CategoryTile key={cat} cat={cat} index={i} />)}
        </div>
      </div>
    </section>
  )
}

function CategoryTile({ cat, index }: { cat: Category; index: number }) {
  const meta = CATEGORY_META[cat]
  const t = TONE[meta.tone]
  const contracts = CONTRACTS.filter((c) => c.category === cat)

  return (
    <Link
      href={COMMODITY_HREF(meta.headline)}
      className={`group relative border-2 ${t.border} bg-slate-950/70 p-4 sm:p-5 transition-all duration-300 ${t.ring} hover:-translate-y-0.5`}
    >
      <div className="flex items-center justify-between mb-3">
        <span className={`font-mono text-[10px] tracking-[0.32em] uppercase ${t.accent}`}>
          #{index + 1} · {cat}
        </span>
        <span
          className="w-1.5 h-1.5 rounded-full animate-pulse"
          style={{ backgroundColor: t.hex, boxShadow: `0 0 8px ${t.hex}` }}
        />
      </div>

      <div className={`text-[clamp(1.6rem,4vw,2.4rem)] font-black tracking-tight uppercase text-white leading-[0.95] ${t.glow}`}>
        {meta.label}
      </div>

      <p className="mt-3 font-mono text-[10px] leading-relaxed text-slate-400 line-clamp-3">
        {meta.blurb}
      </p>

      <ul className={`mt-4 border-t ${t.borderSoft} pt-3 space-y-1.5`}>
        {contracts.map((c) => (
          <li key={c.root} className="flex items-baseline justify-between font-mono text-[10px] tracking-wider gap-3">
            <span className={`uppercase font-bold ${c.headline ? t.accent : 'text-slate-500'}`}>{c.root}</span>
            <span className="text-slate-500 truncate text-right">{c.name.toLowerCase()}</span>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex items-center justify-between font-mono text-[9px] tracking-[0.32em] uppercase text-slate-600">
        <span>headline · {meta.headline}</span>
        <span className={`transition-colors group-hover:${t.accent}`}>open desk →</span>
      </div>
    </Link>
  )
}

function PlaybookSection() {
  return (
    <section className="border-b-2 border-orange-500/20">
      <div className="mx-auto max-w-7xl px-4 sm:px-8 py-10 sm:py-14">
        <div className="flex items-baseline justify-between gap-4 mb-5 sm:mb-8">
          <div>
            <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-orange-500/80 uppercase">
              ▌▌▌ the desk · worked
            </p>
            <h2 className="mt-2 text-[clamp(1.6rem,5vw,3rem)] font-black tracking-tight uppercase text-white">
              how to <span className="text-orange-400">read</span> it.
            </h2>
            <p className="mt-3 max-w-xl text-sm text-slate-400 leading-relaxed">
              Each headline contract has its own term structure and its own way to use the curve.
              Pick a desk for the worked-out trade, the math, and the stop.
            </p>
          </div>
          <p className="hidden sm:block font-mono text-[10px] tracking-[0.3em] text-slate-500 uppercase max-w-[16rem] text-right">
            primary trade<br />edge trigger
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-4">
          {HEADLINE_ROOTS.map((root, i) => <PlaybookTile key={root} root={root} index={i} />)}
        </div>
      </div>
    </section>
  )
}

function PlaybookTile({ root, index }: { root: HeadlineRoot; index: number }) {
  const book = PLAYBOOKS[root]
  const t = TONE[book.tone]
  const ref = useRef<HTMLAnchorElement>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setShown(true) },
      { threshold: 0.15 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <Link
      ref={ref}
      href={COMMODITY_HREF(root)}
      style={{ transitionDelay: `${index * 80}ms` }}
      className={`group relative border-2 ${t.border} bg-slate-950/70 p-4 sm:p-5 transition-all duration-500 ${t.ring} hover:-translate-y-0.5 ${
        shown ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
      }`}
    >
      <div className="flex items-center justify-between mb-3">
        <span className={`font-mono text-[10px] tracking-[0.32em] uppercase ${t.accent}`}>{root}</span>
        <span className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-700 truncate ml-2">
          {book.primaryTrade}
        </span>
      </div>

      <div className={`text-[clamp(2rem,5vw,2.8rem)] font-black tracking-tight leading-[0.95] uppercase text-white ${t.glow}`}>
        {root}
      </div>

      <p className="mt-3 font-mono text-[10px] sm:text-[11px] leading-relaxed text-slate-400 line-clamp-3">
        {book.thesis}
      </p>

      <div className={`mt-4 border-t ${t.borderSoft} pt-3 flex items-baseline justify-between gap-2`}>
        <span className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-500">trigger</span>
        <span className={`font-mono text-[10px] tabular-nums ${t.accent} truncate`}>{book.edgeTrigger}</span>
      </div>

      <div className="mt-3 flex items-center justify-between font-mono text-[9px] tracking-[0.32em] uppercase text-slate-600 gap-2">
        <span className="truncate">{book.primary.name.toLowerCase()}</span>
        <span className={`whitespace-nowrap transition-colors group-hover:${t.accent}`}>open guide →</span>
      </div>
    </Link>
  )
}

function RosterSection() {
  return (
    <section className="border-b-2 border-orange-500/20">
      <div className="mx-auto max-w-7xl px-4 sm:px-8 py-10 sm:py-14">
        <div className="flex items-baseline justify-between gap-4 mb-5 sm:mb-8">
          <div>
            <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-orange-500/80 uppercase">
              ▌▌▌ on the board
            </p>
            <h2 className="mt-2 text-[clamp(1.6rem,5vw,3rem)] font-black tracking-tight uppercase text-white">
              the <span className="text-orange-400">roster</span>.
            </h2>
          </div>
          <p className="hidden sm:block font-mono text-[10px] tracking-[0.3em] text-slate-500 uppercase max-w-[20rem] text-right">
            five headline desks live<br />remaining ten land in v2
          </p>
        </div>

        <div className="border-2 border-orange-500/20 bg-slate-950/40">
          <div className="grid grid-cols-[3rem_1fr_4rem_3rem] sm:grid-cols-[5rem_2fr_7rem_2fr_5rem_5rem_4rem] gap-2 sm:gap-3 items-baseline px-3 sm:px-4 py-3 border-b-2 border-orange-500/20 font-mono text-[9px] tracking-[0.32em] uppercase text-slate-500">
            <span>root</span>
            <span>name</span>
            <span className="hidden sm:block">category</span>
            <span className="hidden sm:block">size</span>
            <span className="text-right">$/tick</span>
            <span className="hidden sm:block">venue</span>
            <span className="text-right">→</span>
          </div>

          <div className="divide-y divide-orange-500/10">
            {CONTRACTS.map((c) => <RosterRow key={c.root} c={c} />)}
          </div>
        </div>
      </div>
    </section>
  )
}

function RosterRow({ c }: { c: Contract }) {
  const t = TONE[c.tone]
  const sizeStr = `${c.contractSize.toLocaleString()} ${c.contractUnit}`
  const tickStr = `$${c.tickValue.toFixed(2)}`

  const cells = (
    <div className="grid grid-cols-[3rem_1fr_4rem_3rem] sm:grid-cols-[5rem_2fr_7rem_2fr_5rem_5rem_4rem] gap-2 sm:gap-3 items-baseline px-3 sm:px-4 py-3 font-mono text-[10px] sm:text-[11px]">
      <span className={`font-black tracking-wider uppercase tabular-nums ${c.headline ? t.accent : 'text-slate-400'}`}>{c.root}</span>
      <span className={`tracking-wide truncate ${c.headline ? 'text-white' : 'text-slate-500'}`}>{c.name}</span>
      <span className="hidden sm:block tracking-[0.25em] uppercase text-slate-500 truncate">{c.category}</span>
      <span className="hidden sm:block tabular-nums text-slate-400 truncate">{sizeStr}</span>
      <span className={`tabular-nums text-right ${c.headline ? t.accent : 'text-slate-500'}`}>{tickStr}</span>
      <span className="hidden sm:block tracking-[0.25em] uppercase text-slate-500">{c.exchange}</span>
      <span className="text-right">
        {c.headline ? (
          <span className={`font-mono text-[9px] tracking-[0.32em] uppercase ${t.accent}`}>open</span>
        ) : (
          <span className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-700 border border-slate-700 px-1.5 py-0.5">v2</span>
        )}
      </span>
    </div>
  )

  if (c.headline) {
    return (
      <Link href={COMMODITY_HREF(c.root)} className="group block hover:bg-slate-900/40 transition-colors">
        {cells}
      </Link>
    )
  }
  return <div className="opacity-70">{cells}</div>
}
