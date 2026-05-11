import Link from 'next/link'

interface Local {
  slug: string
  name: string
  role: string
  tagline: string
  href: string
  initials: string
  accent: 'rose' | 'amber' | 'emerald'
}

const LOCALS: Local[] = [
  {
    slug: 'morgan-tanaka',
    name: 'Morgan Tanaka',
    role: 'handicapper · the fade',
    tagline: 'Fades the public opinion.',
    href: '/handicappers',
    initials: 'MT',
    accent: 'rose',
  },
]

const ACCENT: Record<Local['accent'], { border: string; text: string; glow: string; dot: string; chip: string }> = {
  rose:    { border: 'border-rose-500/40 hover:border-rose-300',     text: 'text-rose-300',    glow: 'hover:shadow-[0_0_60px_-15px_rgba(244,63,94,0.55)]',   dot: 'bg-rose-400',    chip: 'border-rose-500/50 text-rose-200' },
  amber:   { border: 'border-amber-500/40 hover:border-amber-300',   text: 'text-amber-300',   glow: 'hover:shadow-[0_0_60px_-15px_rgba(245,158,11,0.55)]', dot: 'bg-amber-400',   chip: 'border-amber-500/50 text-amber-200' },
  emerald: { border: 'border-emerald-500/40 hover:border-emerald-300', text: 'text-emerald-300', glow: 'hover:shadow-[0_0_60px_-15px_rgba(16,185,129,0.55)]', dot: 'bg-emerald-400', chip: 'border-emerald-500/50 text-emerald-200' },
}

export default function LocalsPage() {
  return (
    <main className="min-h-dvh w-full bg-[#0a0c14] text-slate-100 selection:bg-amber-500/30 selection:text-amber-100">
      <div
        className="pointer-events-none fixed inset-0 -z-10 opacity-40"
        style={{
          backgroundImage:
            'linear-gradient(rgba(245,158,11,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(245,158,11,0.06) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />

      <header className="sticky top-0 z-30 border-b-2 border-amber-500/20 bg-[#0a0c14]/85 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-3 flex items-center justify-between">
          <Link href="/" className="group flex items-center gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shadow-[0_0_10px_rgba(245,158,11,0.9)]" />
            <span className="font-mono text-[10px] tracking-[0.32em] text-amber-500/80 uppercase group-hover:text-amber-300 transition-colors">
              ▓ park · locals
            </span>
          </Link>
          <Link href="/" className="font-mono text-[10px] tracking-[0.32em] text-slate-500 hover:text-amber-300 uppercase transition-colors">
            ← thepark.world
          </Link>
        </div>
      </header>

      <section className="border-b-2 border-amber-500/20">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 pt-10 sm:pt-16 pb-8 sm:pb-12">
          <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase">
            ▌▌▌ the locals
          </p>
          <h1 className="mt-2 text-[clamp(2.2rem,7vw,4.4rem)] font-black tracking-tight leading-[0.92] uppercase">
            <span className="text-white">people</span>
            <span className="text-amber-400 [text-shadow:0_0_30px_rgba(245,158,11,0.45)]"> around</span>
            <span className="text-white"> the park</span>
            <span className="text-amber-400">.</span>
          </h1>
          <p className="mt-4 max-w-xl text-sm text-slate-400 leading-relaxed">
            Operators, sharps, and side characters who keep the lights on.
            Tap a card to find out what they do.
          </p>
        </div>
      </section>

      <section>
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-10 sm:py-14">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
            {LOCALS.map((local, i) => (
              <LocalCard key={local.slug} local={local} index={i} />
            ))}
          </div>
        </div>
      </section>

      <footer className="bg-slate-950/40">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-7 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <Link
            href="/"
            className="group flex items-center gap-3 font-mono text-[11px] tracking-[0.32em] text-amber-500 uppercase hover:text-amber-300 transition-colors"
          >
            <span className="text-2xl leading-none transition-transform group-hover:-translate-x-0.5">←</span>
            thepark.world
          </Link>
          <span className="font-mono text-[9px] tracking-[0.3em] text-slate-700 uppercase">
            locals · directory · v1
          </span>
        </div>
      </footer>
    </main>
  )
}

function LocalCard({ local, index }: { local: Local; index: number }) {
  const t = ACCENT[local.accent]
  return (
    <Link
      href={local.href}
      className={`group relative border-2 ${t.border} bg-slate-950/70 backdrop-blur-sm transition-all duration-300 hover:-translate-y-0.5 ${t.glow} overflow-hidden`}
    >
      <div className="relative aspect-[3/4] overflow-hidden border-b border-slate-800/80">
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(120% 80% at 50% 0%, rgba(244,63,94,0.18), transparent 60%), linear-gradient(180deg, #15161f 0%, #0a0c14 100%)',
          }}
        />
        <div
          className="absolute inset-0 opacity-[0.12] mix-blend-overlay"
          style={{
            backgroundImage:
              'repeating-linear-gradient(45deg, rgba(255,255,255,0.6) 0 1px, transparent 1px 6px)',
          }}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-mono text-[clamp(4rem,12vw,7rem)] font-black tracking-tight text-white/10 group-hover:text-white/20 transition-colors leading-none">
            {local.initials}
          </span>
        </div>
        <div className="absolute top-3 left-3 flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full ${t.dot} animate-pulse shadow-[0_0_10px_currentColor]`} />
          <span className={`font-mono text-[9px] tracking-[0.3em] uppercase ${t.text}`}>
            #{String(index + 1).padStart(2, '0')} · local
          </span>
        </div>
        <div className="absolute bottom-0 inset-x-0 h-1/2 pointer-events-none"
             style={{ background: 'linear-gradient(180deg, transparent, rgba(10,12,20,0.85) 80%)' }} />
      </div>

      <div className="relative p-4 sm:p-5">
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <h3 className="text-xl sm:text-2xl font-black tracking-tight text-white leading-tight uppercase">
            {local.name}
          </h3>
          <span className={`font-mono text-[9px] tracking-[0.3em] uppercase px-1.5 py-0.5 border ${t.chip} whitespace-nowrap`}>
            fade
          </span>
        </div>
        <div className="font-mono text-[10px] sm:text-[11px] tracking-[0.3em] text-slate-500 uppercase mb-3">
          {local.role}
        </div>
        <p className="text-sm text-slate-300 leading-relaxed">
          {local.tagline}
        </p>

        <div className="mt-4 border-t border-slate-800 pt-3 flex items-center justify-between font-mono text-[9px] tracking-[0.32em] uppercase text-slate-600">
          <span>{local.href}</span>
          <span className={`transition-colors group-hover:${t.text}`}>open →</span>
        </div>
      </div>
    </Link>
  )
}
