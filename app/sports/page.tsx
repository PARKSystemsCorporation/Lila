'use client'

import Link from 'next/link'

export default function SportsStub() {
  return (
    <main className="relative h-dvh w-full overflow-hidden bg-[#0a0c14] text-slate-100 select-none">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 25% 30%, rgba(239,68,68,0.10), transparent 55%), radial-gradient(ellipse at 75% 70%, rgba(251,146,60,0.07), transparent 55%)',
        }}
      />

      <header className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-5 sm:px-8 py-4">
        <Link href="/" className="font-mono text-[10px] tracking-[0.3em] text-red-500/70 hover:text-red-300 uppercase">
          ← the park.world
        </Link>
        <span className="font-mono text-[10px] tracking-[0.3em] text-red-700/70 uppercase">sports</span>
      </header>

      <section className="relative z-10 h-full flex flex-col items-center justify-center px-6 text-center">
        <p className="font-mono text-[10px] tracking-[0.45em] text-red-500/70 uppercase mb-3">handicapper desk</p>
        <h1 className="text-[clamp(2.4rem,8vw,5rem)] font-bold tracking-tight leading-[0.95] text-white">
          <span className="text-red-400 [text-shadow:0_0_40px_rgba(239,68,68,0.45)]">edges</span>
          <span className="text-slate-500">, mathematically.</span>
        </h1>
        <p className="mt-5 max-w-xl text-sm sm:text-base text-slate-400 leading-relaxed">
          Ceelo&rsquo;s NFL Elo graph diffed against live book lines.
          <br />
          <span className="text-slate-500">Refreshed at midnight and noon Pacific.</span>
        </p>

        <div className="mt-10 inline-flex items-center gap-3 rounded-full border border-red-500/30 bg-slate-950/40 px-5 py-2.5 backdrop-blur-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.9)]" />
          <span className="font-mono text-[10px] tracking-[0.3em] uppercase text-red-300">building · check back soon</span>
        </div>
      </section>
    </main>
  )
}
