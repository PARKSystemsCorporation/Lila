import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Lila · Pre-Audit Scan',
  description: 'Catch the obvious bugs before your $50k audit invoices. PARKSystems Corporation.',
}

// Public sales page for the pre-audit scan service. Mirrors the look of
// /specs/ads-cleaning. Operator screenshots or links from a sales site.

const TIERS = [
  {
    name: 'Quick scan',
    price: 500,
    days: '48h',
    bullets: [
      'Single contract or small repo (≤ 1500 lines)',
      'Architecture map + attack-surface enumeration',
      'Top-line invariants worth defending',
      'Plain-text findings list (no PoC)',
    ],
  },
  {
    name: 'Standard scan',
    price: 1000,
    days: '4–5 days',
    bullets: [
      'Up to 4 contracts, 5000 lines total',
      'Everything in Quick scan',
      '5–8 hypotheses investigated with confirm/discard verdicts',
      'Per-finding severity (Critical / High / Medium / Low) with reasoning',
    ],
  },
  {
    name: 'Deep scan',
    price: 2000,
    days: '7–10 days',
    bullets: [
      'Repo-scale (≤ 15000 lines)',
      'Everything in Standard scan',
      'Full markdown report with PoC sketches per finding',
      'Recommended fix per item',
      'One follow-up call after delivery',
    ],
  },
]

const VS_FORMAL = [
  ['Cost',     '$500–$2,000',           '$30k–$100k'],
  ['Time',     '2–10 days',             '3–6 weeks'],
  ['Coverage', 'Obvious / common-class', 'Comprehensive + custom'],
  ['Output',   'Markdown findings',     'Audited firm report'],
  ['Best for', 'Pre-launch sanity',     'Pre-mainnet final pass'],
]

export default function PreAuditSpec() {
  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100 font-mono antialiased">
      <div className="max-w-xl mx-auto px-6 py-10 space-y-8">
        {/* Mark */}
        <div className="text-center">
          <pre className="text-emerald-600/80 text-[10px] leading-tight whitespace-pre select-none">
{`▓▒░ PARKSYSTEMS CORPORATION ░▒▓`}
          </pre>
          <p className="text-[9px] tracking-[0.3em] text-slate-700 mt-2 uppercase">
            Pre-Audit Scan · Service Spec
          </p>
        </div>

        {/* Hero */}
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold text-white tracking-tight">Pre-Audit Scan</h1>
          <p className="text-sm text-emerald-400 tracking-wider uppercase">
            Catch the obvious before the $50k audit invoice
          </p>
          <p className="text-xs text-slate-500 leading-relaxed pt-2 max-w-sm mx-auto">
            A targeted security pass before you submit to a formal audit firm.
            Not a replacement for a real audit — a filter that catches the
            cheap-to-fix issues so the expensive auditors don&apos;t spend
            three weeks pointing them out at $500/hr.
          </p>
        </div>

        {/* What you get */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-3">
          <p className="text-[10px] text-slate-500 uppercase tracking-widest">What we deliver</p>
          <ul className="space-y-2 text-xs text-slate-300 leading-snug">
            <li className="flex gap-2">
              <span className="text-emerald-500 shrink-0">▸</span>
              <span><span className="text-white font-semibold">Architecture map.</span> Actors, contracts, money flow, privileged roles. The brief your audit firm wishes you&apos;d sent first.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-emerald-500 shrink-0">▸</span>
              <span><span className="text-white font-semibold">Attack-surface enumeration.</span> Public entry points, oracle reads, external calls, upgrade paths.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-emerald-500 shrink-0">▸</span>
              <span><span className="text-white font-semibold">Invariants worth defending.</span> 3–15 properties that must hold for solvency / correctness, framed as &quot;X must never happen.&quot;</span>
            </li>
            <li className="flex gap-2">
              <span className="text-emerald-500 shrink-0">▸</span>
              <span><span className="text-white font-semibold">Hypotheses + verdicts.</span> Specific attack ideas tested against the code; each gets confirmed (with PoC sketch) or discarded with reasoning.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-emerald-500 shrink-0">▸</span>
              <span><span className="text-white font-semibold">Findings markdown.</span> The exact format your auditors expect, ready to ship to your security lead.</span>
            </li>
          </ul>
        </div>

        {/* Pricing */}
        <div className="space-y-3">
          <p className="text-[10px] text-slate-500 uppercase tracking-widest text-center">Pricing</p>
          {TIERS.map(t => (
            <div key={t.name} className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-2">
              <div className="flex items-baseline justify-between">
                <p className="text-sm text-white font-semibold">{t.name}</p>
                <p className="text-2xl font-bold text-emerald-400 tabular-nums">
                  ${t.price.toLocaleString()}
                </p>
              </div>
              <p className="text-[10px] text-slate-600">turnaround: {t.days}</p>
              <ul className="space-y-1 text-[11px] text-slate-400 leading-snug pt-1 border-t border-slate-800">
                {t.bullets.map((b, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-slate-700 shrink-0">·</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* vs full audit */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-3">
          <p className="text-[10px] text-slate-500 uppercase tracking-widest">
            Pre-audit scan vs. full audit
          </p>
          <p className="text-[10px] text-slate-600 leading-relaxed">
            We are NOT a replacement for a formal audit. Use a real firm
            (Trail of Bits / Spearbit / OpenZeppelin / etc.) before mainnet.
            We&apos;re what you do <em>before</em> them.
          </p>
          <div className="space-y-1.5 text-[11px] font-mono">
            <div className="grid grid-cols-3 gap-2 pb-1.5 border-b border-slate-800 text-[9px] text-slate-500 uppercase tracking-widest">
              <span></span>
              <span className="text-emerald-500">This scan</span>
              <span className="text-slate-500">Formal audit</span>
            </div>
            {VS_FORMAL.map(([label, ours, theirs]) => (
              <div key={label} className="grid grid-cols-3 gap-2 py-0.5">
                <span className="text-slate-500">{label}</span>
                <span className="text-slate-200">{ours}</span>
                <span className="text-slate-400">{theirs}</span>
              </div>
            ))}
          </div>
        </div>

        {/* How it works */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-3">
          <p className="text-[10px] text-slate-500 uppercase tracking-widest">How it works</p>
          <ol className="space-y-2 text-xs text-slate-300 leading-snug list-decimal list-inside">
            <li>You send the repo URL or zipped source + scope notes.</li>
            <li>We pin it as a research target. Phase machine: <span className="text-slate-500">map → surfaces → invariants → hypothesize → investigate.</span></li>
            <li>Lila reviews every output before it leaves us. No fabricated findings, ever.</li>
            <li>Markdown report delivered as agreed. Optional 30-min follow-up call on Deep tier.</li>
          </ol>
        </div>

        {/* CTA */}
        <div className="rounded-2xl border border-emerald-900/60 bg-emerald-950/30 p-5 space-y-2 text-center">
          <p className="text-[10px] text-emerald-500 uppercase tracking-widest">Start a scan</p>
          <p className="text-sm text-slate-200">
            Reply with the repo URL and the tier you want.
          </p>
          <p className="text-[10px] text-slate-600 leading-relaxed pt-1">
            Email / Bluesky — whichever channel you reached us on.
            Quick scans usually start same-day if scope is in.
          </p>
        </div>

        {/* Footer */}
        <div className="text-center pt-2">
          <p className="text-[10px] text-slate-600 tracking-widest uppercase">
            PARKSystems Corporation · 2026
          </p>
        </div>
      </div>
    </div>
  )
}
