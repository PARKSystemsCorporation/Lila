// Inline "how this works" / "how to trade this" slab. Matches the
// brutalist border-2 + mono uppercase title aesthetic of the rest of
// the landing.

type Tone = 'amber' | 'orange'

const TONE_CLASSES: Record<Tone, { border: string; bg: string; title: string }> = {
  amber:  { border: 'border-amber-500/30',  bg: 'bg-amber-500/[0.04]',  title: 'text-amber-400' },
  orange: { border: 'border-orange-500/30', bg: 'bg-orange-500/[0.04]', title: 'text-orange-400' },
}

export function ExplainBox({
  title,
  tone = 'amber',
  children,
}: {
  title: string
  tone?: Tone
  children: React.ReactNode
}) {
  const c = TONE_CLASSES[tone]
  return (
    <div className={`mt-6 border-2 ${c.border} ${c.bg} p-4 sm:p-5`}>
      <div className={`font-mono text-[10px] tracking-[0.32em] uppercase ${c.title}`}>
        ▌ {title}
      </div>
      <div className="mt-3 text-sm sm:text-[15px] leading-relaxed text-slate-300">
        {children}
      </div>
    </div>
  )
}
