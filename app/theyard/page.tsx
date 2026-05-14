// /theyard — placeholder for the room the locals work out of.
// Reached from the second door on the member landing. Content TBD.

'use client'

import { LocalShell } from '@/app/_components/local/chrome'

export default function TheYardPage() {
  return (
    <LocalShell
      title="THE YARD"
      subtitle="The locals' room. Coming soon."
      accent="amber"
      back={{ href: '/', label: 'back to home' }}
    >
      <section className="mx-auto max-w-3xl px-5 sm:px-8 py-16 text-center">
        <p className="font-mono text-[11px] tracking-[0.45em] uppercase text-amber-400/80 mb-4">
          ▌▌▌ under construction
        </p>
        <h1 className="text-[clamp(2rem,6vw,3.4rem)] font-black tracking-tight uppercase text-white leading-[0.95]">
          the yard <span className="text-amber-400">opens soon</span>
        </h1>
        <p className="mt-4 text-sm sm:text-base text-slate-400 leading-relaxed">
          We&rsquo;re framing the room. Check back.
        </p>
      </section>
    </LocalShell>
  )
}
