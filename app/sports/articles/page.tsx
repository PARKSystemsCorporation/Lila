import Link from 'next/link'

export const dynamic = 'force-static'

export default function SportsArticlesStub() {
  return (
    <main className="min-h-dvh w-full bg-[#0a0c14] text-slate-100">
      <div
        className="pointer-events-none fixed inset-0 -z-10 opacity-30"
        style={{
          backgroundImage:
            'linear-gradient(rgba(239,68,68,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(239,68,68,0.06) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />

      <header className="sticky top-0 z-30 border-b-2 border-red-500/20 bg-[#0a0c14]/85 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-3 flex items-center justify-between">
          <Link href="/sports" className="font-mono text-[10px] tracking-[0.32em] text-red-400/80 hover:text-red-300 uppercase">
            ← sports
          </Link>
          <span className="font-mono text-[10px] tracking-[0.32em] text-red-400/80 uppercase">
            ▓ ceelo · notebook
          </span>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-4 sm:px-8 pt-12 sm:pt-20 pb-10">
        <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-slate-500 uppercase mb-4">
          ▌▌▌ all articles
        </p>
        <h1 className="text-[clamp(2.6rem,10vw,7rem)] font-black tracking-tight leading-[0.85] uppercase text-white">
          the <span className="text-red-400">notebook</span>.
        </h1>
        <p className="mt-5 max-w-xl text-sm sm:text-base text-slate-400 leading-relaxed">
          Ceelo&rsquo;s full archive — every noon report, every settle-day recap. Building the public
          feed now; the latest three are already live on the sports landing.
        </p>
      </section>

      <section className="mx-auto max-w-7xl px-4 sm:px-8 pb-12">
        <div className="border-2 border-red-500/30 bg-slate-950/60 p-6 sm:p-10">
          <div className="flex items-center gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
            <span className="font-mono text-[10px] tracking-[0.3em] text-red-300 uppercase">building · check back soon</span>
          </div>
        </div>
      </section>

      <footer className="mx-auto max-w-7xl px-4 sm:px-8 py-7 flex items-center justify-between">
        <Link
          href="/"
          className="group flex items-center gap-3 font-mono text-[11px] tracking-[0.32em] text-amber-500 uppercase hover:text-amber-300 transition-colors"
        >
          <span className="text-2xl leading-none transition-transform group-hover:-translate-x-0.5">←</span>
          thepark.world
        </Link>
        <Link href="/sports" className="font-mono text-[10px] tracking-[0.32em] text-slate-500 hover:text-amber-300 uppercase transition-colors">
          all sports →
        </Link>
      </footer>
    </main>
  )
}
