'use client'

import Link from 'next/link'
import { LocalShell } from '@/app/_components/local/chrome'

export default function HandicappersPage() {
  return (
    <LocalShell>
      <section className="relative px-5 sm:px-8 pt-10 sm:pt-16 pb-10 max-w-5xl mx-auto text-center">
        <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-rose-400/90 uppercase mb-5">
          ▌▌▌ the handicappers
        </p>
        <h1 className="text-[clamp(2.6rem,10vw,6.5rem)] font-black tracking-tight leading-[0.9] uppercase">
          <span className="block text-white">fade</span>
          <span className="block text-rose-400">
            the public
          </span>
        </h1>
        <p className="mt-6 max-w-xl mx-auto text-base text-slate-400 leading-relaxed">
          Locals who make a living betting against consensus. When they file
          a pick, you&rsquo;ll see the line, the side, and their reasoning.
        </p>
      </section>

      <section className="relative px-5 sm:px-8 pb-12 max-w-5xl mx-auto">
        <div className="border-2 border-rose-500/40 bg-slate-950/70 p-6 sm:p-8">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" />
              <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-rose-300">
                morgan tanaka
              </span>
            </div>
            <span className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-600">
              the fade
            </span>
          </div>
          <h2 className="text-2xl sm:text-3xl font-black tracking-tight text-white leading-tight uppercase">
            No picks yet.
          </h2>
          <p className="mt-3 text-sm text-slate-400 leading-relaxed">
            Morgan&rsquo;s board is empty. Check back when the public piles in
            on a side worth fading.
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link
              href="/local"
              className="inline-flex items-center justify-between gap-3 border-2 border-rose-500/50 hover:border-rose-300 px-5 py-3 font-mono text-[10px] tracking-[0.32em] uppercase text-rose-200 hover:text-white transition-colors"
            >
              <span>back to the local</span>
              <span>→</span>
            </Link>
            <Link
              href="/local/sports"
              className="inline-flex items-center justify-between gap-3 border-2 border-amber-500/50 hover:border-amber-300 px-5 py-3 font-mono text-[10px] tracking-[0.32em] uppercase text-amber-200 hover:text-white transition-colors"
            >
              <span>see ceelo&rsquo;s edges</span>
              <span>→</span>
            </Link>
          </div>
        </div>
      </section>
    </LocalShell>
  )
}
