'use client'

import Link from 'next/link'

// Persistent bottom bar: Home + Login. Stays visible at any scroll
// position so visitors can always reach login from anywhere on the page.

export function StickyFooterNav() {
  return (
    <div
      className="fixed bottom-0 inset-x-0 z-30 bg-[#0a0c14]/95 backdrop-blur border-t-2 border-amber-500/40"
      style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom))' }}
    >
      <div className="max-w-7xl mx-auto px-5 sm:px-8 py-3 flex items-center justify-between gap-3">
        <Link
          href="#top"
          className="inline-flex items-center gap-2 font-mono text-[10px] tracking-[0.32em] uppercase text-amber-300 hover:text-white transition-colors"
        >
          ▌ home
        </Link>
        <Link
          href="/login"
          className="inline-flex items-center gap-2 border-2 border-amber-500/60 hover:border-amber-300 text-amber-300 hover:text-white px-4 py-2 font-mono text-[10px] tracking-[0.32em] uppercase transition-colors"
        >
          local sign in →
        </Link>
      </div>
    </div>
  )
}
