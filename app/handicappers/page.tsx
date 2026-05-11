import Link from 'next/link'

export default function HandicappersPage() {
  return (
    <main className="min-h-dvh w-full bg-[#0a0c14] text-slate-100 selection:bg-rose-500/30 selection:text-rose-100">
      <div
        className="pointer-events-none fixed inset-0 -z-10 opacity-40"
        style={{
          backgroundImage:
            'linear-gradient(rgba(244,63,94,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(244,63,94,0.06) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />

      <header className="sticky top-0 z-30 border-b-2 border-rose-500/20 bg-[#0a0c14]/85 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-3 flex items-center justify-between">
          <Link href="/locals" className="group flex items-center gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse shadow-[0_0_10px_rgba(244,63,94,0.9)]" />
            <span className="font-mono text-[10px] tracking-[0.32em] text-rose-400/80 uppercase group-hover:text-rose-300 transition-colors">
              ▓ park · handicappers
            </span>
          </Link>
          <Link href="/locals" className="font-mono text-[10px] tracking-[0.32em] text-slate-500 hover:text-rose-300 uppercase transition-colors">
            ← locals
          </Link>
        </div>
      </header>

      <section className="border-b-2 border-rose-500/20">
        <div className="mx-auto max-w-5xl px-4 sm:px-8 pt-10 sm:pt-16 pb-10 sm:pb-16">
          <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-rose-500/80 uppercase">
            ▌▌▌ the handicappers
          </p>
          <h1 className="mt-2 text-[clamp(2.2rem,7vw,4.4rem)] font-black tracking-tight leading-[0.92] uppercase">
            <span className="text-white">fade</span>
            <span className="text-rose-400 [text-shadow:0_0_30px_rgba(244,63,94,0.45)]"> the</span>
            <span className="text-white"> public</span>
            <span className="text-rose-400">.</span>
          </h1>
          <p className="mt-5 max-w-xl text-sm text-slate-400 leading-relaxed">
            Locals who make a living betting against consensus. Their picks land
            here when they file them.
          </p>
        </div>
      </section>

      <section>
        <div className="mx-auto max-w-5xl px-4 sm:px-8 py-10 sm:py-14">
          <div className="border-2 border-rose-500/30 bg-slate-950/70 p-6 sm:p-8">
            <div className="flex items-center justify-between mb-4">
              <span className="font-mono text-[10px] tracking-[0.3em] uppercase text-rose-300">morgan tanaka</span>
              <span className="font-mono text-[9px] tracking-[0.3em] uppercase text-slate-600">the fade</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-black tracking-tight text-white leading-tight">
              No picks yet.
            </h2>
            <p className="mt-3 text-sm text-slate-400 leading-relaxed">
              Morgan&rsquo;s board is empty. When she fades the public, you&rsquo;ll
              see the line, the side, and her reasoning here.
            </p>
          </div>
        </div>
      </section>

      <footer className="bg-slate-950/40">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-7 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <Link
            href="/locals"
            className="group flex items-center gap-3 font-mono text-[11px] tracking-[0.32em] text-rose-400 uppercase hover:text-rose-300 transition-colors"
          >
            <span className="text-2xl leading-none transition-transform group-hover:-translate-x-0.5">←</span>
            locals
          </Link>
          <span className="font-mono text-[9px] tracking-[0.3em] text-slate-700 uppercase">
            handicappers · v1
          </span>
        </div>
      </footer>
    </main>
  )
}
