'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

// Thin dismissible strip at the very top of the landing. Sells $LDGR as the
// rebar holding the desk together and routes to /tokenomics. Dismissal is
// per-session so a reload doesn't nag, matching the track() idiom elsewhere.

const DISMISS_KEY = 'ldgr_banner_dismissed'

function track(event: string, ref: string) {
  if (typeof window === 'undefined') return
  const k = `pw_track:${event}:${ref}`
  try {
    if (window.sessionStorage.getItem(k)) return
    window.sessionStorage.setItem(k, '1')
  } catch { /* private mode — still send once */ }
  fetch('/api/public/landing-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, ref }),
    keepalive: true,
  }).catch(() => {})
}

export function LdgrBanner() {
  // Start hidden to avoid a flash before the session check resolves.
  const [show, setShow] = useState(false)

  useEffect(() => {
    let dismissed = false
    try { dismissed = window.sessionStorage.getItem(DISMISS_KEY) === '1' } catch { /* noop */ }
    if (!dismissed) {
      setShow(true)
      track('ldgr_banner_view', 'landing')
    }
  }, [])

  if (!show) return null

  const dismiss = () => {
    try { window.sessionStorage.setItem(DISMISS_KEY, '1') } catch { /* noop */ }
    setShow(false)
  }

  return (
    <div className="relative z-30 border-b-2 border-amber-500/40 bg-amber-400 text-black">
      <div className="max-w-7xl mx-auto px-5 sm:px-8 py-2.5 flex items-center gap-3">
        <Link
          href="/tokenomics"
          onClick={() => track('ldgr_tokenomics_click', 'banner')}
          className="group flex min-w-0 flex-1 items-center gap-2.5 sm:gap-4"
        >
          <span className="font-mono text-[10px] sm:text-[11px] tracking-[0.32em] uppercase font-bold shrink-0">
            ▌▌▌ $ldgr ledger
          </span>
          <span className="hidden sm:inline font-mono text-[10px] tracking-[0.28em] uppercase text-black/70 truncate">
            the rebar holding the yard &amp; the yield together
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[10px] sm:text-[11px] tracking-[0.32em] uppercase font-bold shrink-0">
            tokenomics
            <span className="group-hover:translate-x-0.5 transition-transform">→</span>
          </span>
        </Link>
        <button
          type="button"
          onClick={dismiss}
          aria-label="dismiss $ldgr banner"
          className="shrink-0 font-mono text-xs leading-none px-1.5 py-1 text-black/60 hover:text-black transition-colors"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
