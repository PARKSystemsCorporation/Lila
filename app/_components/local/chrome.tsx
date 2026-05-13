'use client'

// Shared chrome for /local and its children. Provides:
//   <LocalShell>  — the radar background + sticky header + footer wrapper
//   <Reticles />  — the corner radar dots / rings
//   inline icon library (sport balls, commodity glyphs, ui pictograms)
//
// Pages compose the shell with a title/subtitle/accent and pass children for
// the main content. The header back-link is configurable so the root /local
// page can omit it while children render "← BACK TO LOCAL".

import Link from 'next/link'
import { useEffect, useState } from 'react'

export type Accent = 'amber' | 'orange'

interface LocalShellProps {
  title?: string
  subtitle?: React.ReactNode
  accent?: Accent
  back?: { href: string; label: string }
  hero?: React.ReactNode
  children: React.ReactNode
}

export function LocalShell({ title, subtitle, accent = 'amber', back, hero, children }: LocalShellProps) {
  const time = useClock()
  const signOut = async () => {
    await fetch('/api/viewer/login', { method: 'DELETE' }).catch(() => {})
    window.location.href = '/'
  }

  const accentText = accent === 'amber' ? 'text-amber-300' : 'text-orange-300'
  const accentGlow = accent === 'amber' ? '' : ''

  return (
    <main className="relative min-h-dvh w-full bg-[#0a0c14] text-slate-100 selection:bg-amber-500/30 selection:text-amber-100 overflow-x-hidden">
      <div
        className="pointer-events-none fixed inset-0 -z-20 opacity-30"
        style={{
          backgroundImage:
            'linear-gradient(rgba(245,158,11,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(245,158,11,0.06) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />
      <Reticles />

      <header
        className="sticky top-0 z-30 border-b-2 border-amber-500/15 bg-[#0a0c14]/85 backdrop-blur-md"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-3 flex items-center justify-between gap-4">
          {back ? (
            <Link
              href={back.href}
              className="group flex items-center gap-2 font-mono text-[10px] tracking-[0.32em] text-amber-500/80 hover:text-amber-300 uppercase transition-colors"
            >
              <span className="text-base group-hover:-translate-x-0.5 transition-transform">‹</span>
              {back.label}
            </Link>
          ) : (
            <Link href="/" className="group flex items-center gap-2.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              <span className="font-mono text-[10px] tracking-[0.32em] text-amber-500/80 uppercase group-hover:text-amber-300 transition-colors">
                ▓ park · local
              </span>
            </Link>
          )}

          {back && (
            <Link
              href="/local"
              className="hidden sm:block font-mono text-[10px] tracking-[0.32em] uppercase text-white"
              aria-label="the park · local"
            >
              ▓ the park · <span className="text-amber-400">local</span>
            </Link>
          )}

          <div className="flex items-center gap-3 sm:gap-4">
            <span className="hidden sm:inline font-mono text-[10px] tracking-[0.25em] text-amber-700/70 uppercase tabular-nums">
              {time && <>pst · {time}</>}
            </span>
            <IconCrosshair />
            <button
              onClick={signOut}
              className="text-amber-500/70 hover:text-amber-300 transition-colors"
              aria-label="Sign out"
              title="Sign out"
            >
              <IconUser />
            </button>
          </div>
        </div>
      </header>

      {title && (
        <section className="relative border-b-2 border-amber-500/15">
          <div className="mx-auto max-w-7xl px-5 sm:px-8 pt-8 sm:pt-12 pb-8 sm:pb-12 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-6 items-end">
            <div>
              <h1 className={`text-[clamp(2.8rem,11vw,7rem)] font-black tracking-tight leading-[0.85] uppercase text-white ${accentGlow}`}>
                {title}
              </h1>
              {subtitle && (
                <p className="mt-3 sm:mt-4 text-sm sm:text-base text-slate-400 leading-relaxed max-w-xl">
                  {typeof subtitle === 'string'
                    ? <>{subtitle.split('. ').map((s, i, a) => (
                        <span key={i} className={i === a.length - 1 && a.length > 1 ? accentText : ''}>
                          {s}{i < a.length - 1 ? '. ' : ''}
                        </span>
                      ))}</>
                    : subtitle}
                </p>
              )}
            </div>
            {hero && <div className="hidden sm:block pointer-events-none">{hero}</div>}
          </div>
        </section>
      )}

      {children}

      <footer
        className="px-5 sm:px-8 py-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 font-mono text-[9px] sm:text-[10px] tracking-[0.32em] uppercase text-slate-700 border-t border-slate-900"
        style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}
      >
        <span>© {new Date().getFullYear()} the park.world · all rights reserved</span>
        <span className="flex items-center gap-5">
          <Link href="/specs" className="hover:text-amber-300 transition-colors">terms</Link>
          <Link href="/specs" className="hover:text-amber-300 transition-colors">privacy</Link>
          <Link href="/specs" className="hover:text-amber-300 transition-colors">responsible</Link>
        </span>
      </footer>
    </main>
  )
}

// ─── Hooks ────────────────────────────────────────────────────────────────

export function useClock() {
  const [t, set] = useState('')
  useEffect(() => {
    const tick = () => set(new Date().toLocaleTimeString('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])
  return t
}

// ─── Reticles ─────────────────────────────────────────────────────────────

export function Reticles() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 w-full h-full opacity-40"
      preserveAspectRatio="none"
    >
      <g stroke="rgba(245,158,11,0.18)" fill="none" strokeWidth="0.5">
        <circle cx="8%"  cy="14%" r="60" />
        <circle cx="8%"  cy="14%" r="32" />
        <circle cx="8%"  cy="14%" r="12" />
        <circle cx="92%" cy="34%" r="70" />
        <circle cx="92%" cy="34%" r="38" />
        <circle cx="92%" cy="34%" r="14" />
        <circle cx="94%" cy="88%" r="50" />
        <circle cx="94%" cy="88%" r="26" />
      </g>
      <g fill="#f59e0b">
        <circle cx="8%"  cy="14%" r="1.5" />
        <circle cx="92%" cy="34%" r="1.5" />
        <circle cx="94%" cy="88%" r="1.5" />
      </g>
    </svg>
  )
}

// ─── Icons ────────────────────────────────────────────────────────────────

const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export function IconTarget()    { return <svg viewBox="0 0 24 24" width="28" height="28" {...STROKE}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /></svg> }
export function IconTrophy()    { return <svg viewBox="0 0 24 24" width="28" height="28" {...STROKE}><path d="M7 4h10v4a5 5 0 0 1-10 0V4z" /><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" /><path d="M9 18h6M10 18v3h4v-3M12 14v4" /></svg> }
export function IconDroplet()   { return <svg viewBox="0 0 24 24" width="28" height="28" {...STROKE}><path d="M12 3s-6 7-6 11a6 6 0 0 0 12 0c0-4-6-11-6-11z" /></svg> }
export function IconBolt()      { return <svg viewBox="0 0 24 24" width="28" height="28" {...STROKE}><path d="M13 3 5 14h6l-1 7 8-11h-6l1-7z" /></svg> }
export function IconShield()    { return <svg viewBox="0 0 24 24" width="28" height="28" {...STROKE}><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3z" /><path d="m9 12 2 2 4-4" /></svg> }
export function IconBasketball(){ return <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3v18M5.6 5.6c3 3 3 9.8 0 12.8M18.4 5.6c-3 3-3 9.8 0 12.8" /></svg> }
export function IconFootball()  { return <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}><ellipse cx="12" cy="12" rx="9" ry="5" /><path d="M7 12h10M9 10v4M12 9.5v5M15 10v4" /></svg> }
export function IconSoccer()    { return <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}><circle cx="12" cy="12" r="9" /><path d="m12 7 4 3-1.5 5h-5L8 10z" /><path d="M12 3v4M3 12h5M21 12h-5M7 21l1-6M17 21l-1-6" /></svg> }
export function IconBaseball()  { return <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}><circle cx="12" cy="12" r="9" /><path d="M6 6c2 2 3 4 3 6s-1 4-3 6M18 6c-2 2-3 4-3 6s1 4 3 6" /></svg> }
export function IconHockey()    { return <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}><ellipse cx="12" cy="15" rx="9" ry="3" /><path d="M3 15v-3M21 15v-3" /><ellipse cx="12" cy="12" rx="9" ry="3" /></svg> }
export function IconGloves()    { return <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}><path d="M7 4h10v8a5 5 0 0 1-5 5 5 5 0 0 1-5-5z" /><path d="M9 4v4M12 4v4M15 4v4M9 17v3h6v-3" /></svg> }
export function IconGold()      { return <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}><path d="M4 18h16l-3-8H7l-3 8z" /><path d="M7 10V7h10v3" /></svg> }
export function IconWheat()     { return <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}><path d="M12 21V8" /><path d="M12 8c-2-2-4-2-5-1 1 2 3 3 5 3M12 8c2-2 4-2 5-1-1 2-3 3-5 3M12 13c-2-2-4-2-5-1 1 2 3 3 5 3M12 13c2-2 4-2 5-1-1 2-3 3-5 3M12 17c-2-2-4-2-5-1 1 2 3 3 5 3M12 17c2-2 4-2 5-1-1 2-3 3-5 3" /></svg> }
export function IconFlame()     { return <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}><path d="M12 3s-1 3 1 6 3 4 3 7a4 4 0 0 1-8 0c0-2 1-3 2-4-1 0-3-1-3-3 0 0 5-1 5-6z" /></svg> }
export function IconBull()      { return <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}><circle cx="12" cy="14" r="6" /><path d="M6 8 3 5M18 8l3-3M9 13h.01M15 13h.01M10 17c1 1 3 1 4 0" /></svg> }
export function IconBarrel()    { return <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}><rect x="6" y="4" width="12" height="16" rx="2" /><path d="M6 9h12M6 15h12" /></svg> }
export function IconCoffee()    { return <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}><path d="M5 8h12v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z" /><path d="M17 10h2a2 2 0 0 1 0 4h-2M9 3c0 1 1 1 1 2s-1 1-1 2M13 3c0 1 1 1 1 2s-1 1-1 2" /></svg> }
export function IconCrosshair() { return <svg viewBox="0 0 24 24" width="18" height="18" {...STROKE} className="text-amber-500/60"><circle cx="12" cy="12" r="7" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></svg> }
export function IconUser()      { return <svg viewBox="0 0 24 24" width="18" height="18" {...STROKE}><circle cx="12" cy="9" r="3" /><path d="M5 20a7 7 0 0 1 14 0" /></svg> }
export function IconPlay()      { return <svg viewBox="0 0 24 24" width="14" height="14" {...STROKE}><path d="M8 5v14l11-7z" /></svg> }
export function IconBroadcast() { return <svg viewBox="0 0 24 24" width="14" height="14" {...STROKE}><circle cx="12" cy="12" r="2" fill="currentColor" /><path d="M8 8a5 5 0 0 0 0 8M16 8a5 5 0 0 1 0 8M5 5a9 9 0 0 0 0 14M19 5a9 9 0 0 1 0 14" /></svg> }
