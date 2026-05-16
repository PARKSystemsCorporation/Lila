// Pure-SVG allocation donut + legend. No client JS, no chart dependency —
// the figures are fixed (1B supply across five transparent buckets).

interface Bucket {
  label: string
  pct: number
  tokens: string
  status: string
  color: string
}

const BUCKETS: Bucket[] = [
  { label: 'Liquidity / Public Sale',        pct: 40, tokens: '400,000,000', status: 'Unlocked',         color: '#f59e0b' },
  { label: 'Ecosystem / Community Rewards',  pct: 25, tokens: '250,000,000', status: 'Vesting 36m',      color: '#fb923c' },
  { label: 'Treasury / Foundation',          pct: 15, tokens: '150,000,000', status: '12m cliff',        color: '#ea580c' },
  { label: 'Team & Advisors',                pct: 12, tokens: '120,000,000', status: 'Locked · 6m cliff', color: '#fde68a' },
  { label: 'Private / Seed',                 pct:  8, tokens:  '80,000,000', status: '6m cliff',         color: '#b45309' },
]

const R = 80
const C = 2 * Math.PI * R

export function AllocationDonut() {
  let offset = 0

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[auto_1fr] gap-8 lg:gap-12 items-center">
      <svg viewBox="0 0 200 200" className="w-56 h-56 sm:w-64 sm:h-64 mx-auto" role="img" aria-label="token allocation donut chart">
        <circle cx="100" cy="100" r={R} fill="none" stroke="rgba(245,158,11,0.08)" strokeWidth="26" />
        <g transform="rotate(-90 100 100)">
          {BUCKETS.map((b) => {
            const dash = (b.pct / 100) * C
            const seg = (
              <circle
                key={b.label}
                cx="100"
                cy="100"
                r={R}
                fill="none"
                stroke={b.color}
                strokeWidth="26"
                strokeDasharray={`${dash} ${C - dash}`}
                strokeDashoffset={-offset}
              />
            )
            offset += dash
            return seg
          })}
        </g>
        <text x="100" y="94" textAnchor="middle" className="fill-white font-mono font-black" fontSize="20">1B</text>
        <text x="100" y="112" textAnchor="middle" className="fill-amber-500/70 font-mono uppercase" fontSize="7" letterSpacing="2">total $ldgr</text>
      </svg>

      <div className="overflow-x-auto">
        <table className="w-full font-mono text-[11px] sm:text-xs">
          <thead>
            <tr className="text-left tracking-[0.18em] uppercase text-amber-500/70 border-b-2 border-amber-500/30">
              <th className="px-3 py-3">Allocation</th>
              <th className="px-3 py-3 text-right">%</th>
              <th className="px-3 py-3 text-right">Tokens</th>
              <th className="px-3 py-3 text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            {BUCKETS.map((b) => (
              <tr key={b.label} className="border-b border-amber-500/10">
                <td className="px-3 py-3.5 text-slate-300">
                  <span className="inline-block h-2.5 w-2.5 mr-2 align-middle" style={{ background: b.color }} />
                  {b.label}
                </td>
                <td className="px-3 py-3.5 text-right text-white">{b.pct.toFixed(2)}%</td>
                <td className="px-3 py-3.5 text-right text-slate-400">{b.tokens}</td>
                <td className="px-3 py-3.5 text-right text-amber-300">{b.status}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-amber-500/30 bg-amber-500/[0.04]">
              <td className="px-3 py-3.5 font-bold text-white">Total</td>
              <td className="px-3 py-3.5 text-right font-bold text-amber-400">100.00%</td>
              <td className="px-3 py-3.5 text-right font-bold text-white">1,000,000,000</td>
              <td className="px-3 py-3.5 text-right text-slate-500">Fixed</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
