'use client'

// Bottom-of-section anchor. Targets #top on the public landing page.

export function ReturnToTop({ tone = 'amber' as 'amber' | 'orange' }) {
  const color = tone === 'orange'
    ? 'border-orange-500/40 hover:border-orange-300 text-orange-300'
    : 'border-amber-500/40 hover:border-amber-300 text-amber-300'
  return (
    <div className="mt-8 flex justify-center">
      <a
        href="#top"
        className={`inline-flex items-center gap-2 border-2 ${color} hover:text-white px-4 py-2 font-mono text-[10px] tracking-[0.32em] uppercase transition-colors`}
      >
        ↑ return to top
      </a>
    </div>
  )
}
