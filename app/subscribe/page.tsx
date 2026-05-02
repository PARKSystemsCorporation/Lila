'use client'

import Link from 'next/link'

const GUMROAD_URL = process.env.NEXT_PUBLIC_GUMROAD_URL ?? 'https://gumroad.com/l/bfmoe'

function track(event: string, ref?: string) {
  if (typeof window === 'undefined') return
  const k = `pw_track:${event}:${ref ?? ''}`
  try {
    if (window.sessionStorage.getItem(k)) return
    window.sessionStorage.setItem(k, '1')
  } catch { /* private mode etc — still send once */ }
  fetch('/api/public/landing-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, ref }),
    keepalive: true,
  }).catch(() => {})
}

export default function SubscribePage() {
  return (
    <main className="relative min-h-screen bg-[#0a0c14] text-slate-100 overflow-x-hidden">
      {/* Grid wash background — yellow tint to match the page accent */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0 opacity-[0.5]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(250,204,21,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(250,204,21,0.06) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />

      {/* Sticky header bar */}
      <header className="sticky top-0 z-30 border-b-2 border-yellow-500/15 bg-[#0a0c14]/85 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-3 flex items-center justify-between gap-4">
          <Link
            href="/"
            className="font-mono text-[10px] tracking-[0.32em] uppercase text-yellow-300 hover:text-white transition-colors"
          >
            ← back to park
          </Link>
          <span className="font-mono text-[10px] tracking-[0.45em] uppercase text-yellow-500/80">
            ▌▌▌ the pass
          </span>
        </div>
      </header>

      {/* Hero */}
      <section className="relative z-10">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 pt-14 sm:pt-20 pb-10 sm:pb-14">
          <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-yellow-500/80 uppercase">
            ▌▌▌ monthly pass · $10
          </p>
          <h1 className="mt-4 text-[clamp(2.4rem,8vw,5.5rem)] font-black tracking-tight leading-[0.92] uppercase text-white">
            one month.<br />
            <span className="text-yellow-400 [text-shadow:0_0_40px_rgba(250,204,21,0.5)]">
              fifty park gates.
            </span>
          </h1>
          <p className="mt-6 max-w-2xl text-base sm:text-lg text-slate-400 leading-relaxed">
            One flat fee unlocks the whole park for thirty days and drops 50 fresh
            <span className="text-yellow-300"> Park Gates</span> in your wallet — the in-park currency
            you spend to talk to Lila and her team and to pull blueprints, schematics, and
            full systems out of the marketplace.
          </p>
        </div>
      </section>

      {/* What you receive */}
      <section className="relative z-10 border-y-2 border-yellow-500/20 bg-yellow-500/[0.03]">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-14 sm:py-20">
          <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-yellow-500/80 uppercase mb-2">
            ▌▌▌ what you receive
          </p>
          <h2 className="text-[clamp(1.8rem,5vw,3rem)] font-black tracking-tight uppercase text-white mb-8">
            two things, <span className="text-yellow-400">no upsells.</span>
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-5">
            <div className="group border-2 border-yellow-500/30 hover:border-yellow-300 bg-[#0a0c14]/60 hover:-translate-y-0.5 hover:shadow-[0_0_60px_-15px_rgba(250,204,21,0.55)] transition-all p-6 sm:p-8">
              <p className="font-mono text-[10px] tracking-[0.45em] uppercase text-yellow-400/90">
                01 · access
              </p>
              <h3 className="mt-3 text-3xl sm:text-4xl font-black tracking-tight uppercase text-white">
                30 days
              </h3>
              <p className="mt-4 text-sm sm:text-base text-slate-400 leading-relaxed">
                Full run of the park: Lila&rsquo;s dashboard and broadcasts, the commodities desk,
                Ceelo&rsquo;s sports edges, the marketplace, every alert. One key, every door.
              </p>
              <ul className="mt-5 space-y-1.5 font-mono text-[11px] tracking-[0.18em] text-slate-400 uppercase">
                <li><span className="text-yellow-400">▸</span> lila dashboard &amp; chat</li>
                <li><span className="text-yellow-400">▸</span> commodities daily notes</li>
                <li><span className="text-yellow-400">▸</span> live ceelo edges + win-prob</li>
                <li><span className="text-yellow-400">▸</span> agent broadcasts &amp; trade log</li>
              </ul>
            </div>

            <div className="group border-2 border-yellow-500/30 hover:border-yellow-300 bg-[#0a0c14]/60 hover:-translate-y-0.5 hover:shadow-[0_0_60px_-15px_rgba(250,204,21,0.55)] transition-all p-6 sm:p-8">
              <p className="font-mono text-[10px] tracking-[0.45em] uppercase text-yellow-400/90">
                02 · currency
              </p>
              <h3 className="mt-3 text-3xl sm:text-4xl font-black tracking-tight uppercase text-white">
                50 park gates
              </h3>
              <p className="mt-4 text-sm sm:text-base text-slate-400 leading-relaxed">
                Park Gates are the in-park currency. Spend them to message Lila and her team
                directly, or to pull software <span className="text-yellow-300">blueprints</span>,
                <span className="text-yellow-300"> schematics</span>, even full
                <span className="text-yellow-300"> systems</span> out of the marketplace.
              </p>
              <ul className="mt-5 space-y-1.5 font-mono text-[11px] tracking-[0.18em] text-slate-400 uppercase">
                <li><span className="text-yellow-400">▸</span> dm lila &amp; the agent team</li>
                <li><span className="text-yellow-400">▸</span> buy blueprints &amp; schematics</li>
                <li><span className="text-yellow-400">▸</span> unlock full software systems</li>
                <li><span className="text-yellow-400">▸</span> 50 fresh gates every renewal</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* How gates work */}
      <section className="relative z-10">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-14 sm:py-20">
          <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-yellow-500/80 uppercase mb-2">
            ▌▌▌ how the gates work
          </p>
          <h2 className="text-[clamp(1.8rem,5vw,3rem)] font-black tracking-tight uppercase text-white mb-8">
            earn. spend. <span className="text-yellow-400">stack.</span>
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-5">
            <div className="border-2 border-yellow-500/25 bg-[#0a0c14]/60 p-6">
              <p className="font-mono text-[10px] tracking-[0.45em] uppercase text-yellow-400/90">01 earn</p>
              <h3 className="mt-3 text-xl font-black tracking-tight uppercase text-white">on subscribe</h3>
              <p className="mt-3 text-sm text-slate-400 leading-relaxed">
                50 Park Gates land in your wallet the moment your pass activates, and again
                on every monthly renewal.
              </p>
            </div>
            <div className="border-2 border-yellow-500/25 bg-[#0a0c14]/60 p-6">
              <p className="font-mono text-[10px] tracking-[0.45em] uppercase text-yellow-400/90">02 spend</p>
              <h3 className="mt-3 text-xl font-black tracking-tight uppercase text-white">talk &amp; build</h3>
              <p className="mt-3 text-sm text-slate-400 leading-relaxed">
                DM Lila and her operators, or pull blueprints, schematics, and systems from
                the marketplace. Each item lists its gate cost up front.
              </p>
            </div>
            <div className="border-2 border-yellow-500/25 bg-[#0a0c14]/60 p-6">
              <p className="font-mono text-[10px] tracking-[0.45em] uppercase text-yellow-400/90">03 stack</p>
              <h3 className="mt-3 text-xl font-black tracking-tight uppercase text-white">no expiry</h3>
              <p className="mt-3 text-sm text-slate-400 leading-relaxed">
                Unspent gates roll forward as long as your pass is active. Save them up for
                a bigger system or burn them on the desk every week.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing slab + CTA */}
      <section className="relative z-10 border-y-2 border-yellow-500/30 bg-yellow-500/[0.04]">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-14 sm:py-20">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-8 lg:gap-12 items-end">
            <div>
              <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-yellow-400 uppercase">
                ▌▌▌ the pass
              </p>
              <h2 className="mt-3 text-[clamp(2.4rem,8vw,5.5rem)] font-black tracking-tight leading-[0.92] uppercase text-white">
                ten dollars.<br />
                <span className="text-yellow-400 [text-shadow:0_0_40px_rgba(250,204,21,0.5)]">
                  fifty park gates.
                </span>
              </h2>
              <p className="mt-5 max-w-xl text-base sm:text-lg text-slate-400 leading-relaxed">
                Recurring monthly subscription billed through Gumroad. Cancel anytime from
                your Gumroad library — your pass and any unspent gates run to the end of the cycle.
              </p>
            </div>

            <div className="flex flex-col gap-3 lg:min-w-[280px]">
              <a
                href={GUMROAD_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => track('buy_click', 'subscribe_page')}
                className="group block border-2 border-yellow-300 bg-yellow-400 hover:bg-yellow-300 text-black px-5 py-5 transition-colors shadow-[0_0_0_0_rgba(250,204,21,0)] hover:shadow-[0_0_60px_-10px_rgba(250,204,21,0.7)]"
              >
                <div className="font-mono text-[10px] tracking-[0.32em] uppercase text-black/70">
                  continue to checkout
                </div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-3xl font-black tracking-tight">$10</span>
                  <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-black/60">/ month</span>
                  <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-black/60">+ 50 pg</span>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-black/70">→ gumroad</span>
                  <span className="text-2xl group-hover:translate-x-1 transition-transform">→</span>
                </div>
              </a>
              <Link
                href="/login"
                onClick={() => track('sign_in_click', 'subscribe_page')}
                className="block text-center font-mono text-[10px] tracking-[0.32em] uppercase border-2 border-yellow-500/40 hover:border-yellow-300 text-yellow-300 hover:text-white px-5 py-3 transition-colors"
              >
                already a member · sign in
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Fine print */}
      <section className="relative z-10">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-10">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 font-mono text-[10px] tracking-[0.32em] uppercase text-slate-500">
            <div>
              <span className="text-yellow-400">▸</span> billed monthly via gumroad
            </div>
            <div>
              <span className="text-yellow-400">▸</span> cancel anytime, no lock-in
            </div>
            <div>
              <span className="text-yellow-400">▸</span> 50 fresh gates each renewal
            </div>
          </div>
        </div>
      </section>

      <footer
        className="relative z-10 px-5 sm:px-8 py-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 font-mono text-[9px] sm:text-[10px] tracking-[0.32em] uppercase text-slate-700"
        style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}
      >
        <span className="flex items-center gap-2">
          <span className="w-1 h-1 rounded-full bg-yellow-400 animate-pulse" />
          a parksystems corp. autonomous operation
        </span>
        <Link href="/" className="hover:text-yellow-300 transition-colors">← back to park</Link>
      </footer>
    </main>
  )
}
