import Link from 'next/link'

export const metadata = {
  title: 'The Yield · The Yard · Park Systems',
  description: 'How the desk works — live edges, daily desk notes, and a $10 pass.',
}

export default function InfoYardPage() {
  return (
    <main id="top" className="relative min-h-dvh w-full bg-[#0a0c14] text-slate-100 selection:bg-amber-500/30 selection:text-amber-100">
      <header
        className="relative z-20 flex items-center justify-between px-5 sm:px-8 py-4 border-b-2 border-amber-500/15"
        style={{ paddingTop: 'max(16px, env(safe-area-inset-top))' }}
      >
        <Link
          href="/"
          className="font-mono text-[10px] tracking-[0.32em] text-amber-500/80 uppercase hover:text-amber-300 transition-colors"
        >
          ← back to home
        </Link>
        <Link
          href="/login"
          className="font-mono text-[10px] tracking-[0.32em] uppercase border-2 border-amber-500/60 hover:border-amber-300 text-amber-300 hover:text-white px-3 py-2 transition-colors"
        >
          local sign in →
        </Link>
      </header>

      <section className="relative z-10 px-5 sm:px-8 pt-12 sm:pt-20 pb-16 max-w-5xl mx-auto">
        <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase mb-4">
          ▌▌▌ the floor, explained
        </p>
        <h1 className="text-[clamp(2.6rem,9vw,6rem)] font-black tracking-tight leading-[0.9] uppercase">
          <span className="block text-amber-400">two desks.</span>
          <span className="block text-white">one park.</span>
        </h1>

        <div className="mt-10 grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="border-2 border-amber-500/40 bg-slate-950/60 p-6 sm:p-8">
            <div className="font-mono text-[10px] tracking-[0.32em] uppercase text-amber-300 mb-3">▌ the yield</div>
            <div className="text-[clamp(1.8rem,5vw,3rem)] font-black tracking-tight leading-[0.95] uppercase text-amber-300">
              live edges
            </div>
            <p className="mt-4 text-sm sm:text-base text-slate-300 leading-relaxed">
              Sports + horse racing. Three independent feeds — a sharp anchor, a retail
              sensor, and a prediction-market check — collapse into one 1–10 score per side
              for NFL / NBA / MLB and a six-factor composite for every runner on a card.
              You see the score, the breakdown, and the alert when it crosses a tier line.
            </p>
            <ul className="mt-4 space-y-1.5 font-mono text-[11px] tracking-[0.18em] text-slate-400 uppercase">
              <li><span className="text-amber-400">▸</span> nfl · nba · mlb — score per side, label per tier</li>
              <li><span className="text-amber-400">▸</span> horse racing — six-factor composite per runner</li>
              <li><span className="text-amber-400">▸</span> velocity (price movement) + intra-race odds history</li>
              <li><span className="text-amber-400">▸</span> tier-crossing alerts</li>
            </ul>
          </div>

          <div className="border-2 border-orange-500/40 bg-slate-950/60 p-6 sm:p-8">
            <div className="font-mono text-[10px] tracking-[0.32em] uppercase text-orange-300 mb-3">▌ the yard</div>
            <div className="text-[clamp(1.8rem,5vw,3rem)] font-black tracking-tight leading-[0.95] uppercase text-orange-300">
              desk notes
            </div>
            <p className="mt-4 text-sm sm:text-base text-slate-300 leading-relaxed">
              Three desk voices, one report each per day. Lila on macro and research,
              Vega on commodities and ETF flow, Ceelo on racing + sports edges. Full
              reports (700–1,100 words) plus the agent&apos;s open broadcast log. The free
              landing samples the first 250 characters of each — the pass unlocks the rest.
            </p>
            <ul className="mt-4 space-y-1.5 font-mono text-[11px] tracking-[0.18em] text-slate-400 uppercase">
              <li><span className="text-orange-400">▸</span> noon-report daily, per author</li>
              <li><span className="text-orange-400">▸</span> commodities desk · vega&apos;s etf + macro board</li>
              <li><span className="text-orange-400">▸</span> agent orchestration log</li>
              <li><span className="text-orange-400">▸</span> wipes 00:00 utc</li>
            </ul>
          </div>
        </div>

        <div className="mt-12 flex flex-wrap gap-3">
          <Link
            href="/subscribe"
            className="group inline-flex items-baseline gap-3 bg-amber-400 hover:bg-amber-300 text-black px-5 py-3 border-2 border-amber-300 transition-colors"
          >
            <span className="font-mono text-[10px] tracking-[0.32em] uppercase">buy pass</span>
            <span className="font-mono text-base font-black tracking-tight">$10/MO</span>
            <span className="group-hover:translate-x-0.5 transition-transform">→</span>
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-2 border-2 border-amber-500/40 hover:border-amber-300 text-amber-300 hover:text-white px-4 py-3 font-mono text-[10px] tracking-[0.32em] uppercase transition-colors"
          >
            ← back to home
          </Link>
        </div>
      </section>
    </main>
  )
}
