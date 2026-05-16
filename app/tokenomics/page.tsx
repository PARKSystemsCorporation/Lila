import Link from 'next/link'
import { AllocationDonut } from './_components/allocation-donut'
import { ContractCopy } from './_components/contract-copy'
import { SupplyChart } from './_components/supply-chart'

export const metadata = {
  title: '$LDGR Tokenomics · Park Systems',
  description:
    '$LDGR LEDGER tokenomics — immutable ledger infrastructure powering the autonomous markets desk. Fixed 1B supply, verifiable on-chain vesting and transparency.',
}

const METRICS = [
  { k: 'Ticker', v: '$LDGR', sub: 'LEDGER · SPL token' },
  { k: 'Chain', v: 'Solana', sub: 'fixed · non-mintable' },
  { k: 'Total Supply', v: '1,000,000,000', sub: 'fixed at genesis' },
  { k: 'Circulating', v: '441,666,667', sub: '≈ 44.17% · computed via api' },
]

const VESTING_FACTS = [
  { k: 'Cliff', v: '6-month cliff', sub: 'Team, Advisors & Private/Seed · 12-month for Treasury' },
  { k: 'Vesting Period', v: 'Linear monthly · 24m', sub: 'Ecosystem emits linearly over 36 months' },
  { k: 'Full Circulation', v: 'Month 36 · 2028-11-01', sub: '100% supply unlocked & verifiable' },
]

const TIMELINE = [
  { m: 'M0 · 2025-11-01', t: 'TGE', d: 'Liquidity & Public Sale fully unlocked' },
  { m: 'M6 · 2026-05-01', t: 'Cliff Release', d: 'Team & Private/Seed linear vesting begins' },
  { m: 'M12 · 2026-11-01', t: 'Treasury Unlock', d: 'Treasury cliff ends · linear vesting begins' },
  { m: 'M36 · 2028-11-01', t: 'Fully Vested', d: '1,000,000,000 fully circulating' },
]

const UNLOCKS = [
  ['2025-11-01', 'TGE — Liquidity / Public Sale', '+400,000,000', '400,000,000', '40.00%'],
  ['2025-12-01', 'Ecosystem emissions begin (~6.94M/mo)', '+6,944,444', '406,944,444', '40.69%'],
  ['2026-05-01', 'Team & Private/Seed cliff ends', '+15,277,777', '456,944,444', '45.69%'],
  ['2026-11-01', 'Treasury cliff ends', '+21,527,777', '533,333,333', '53.33%'],
  ['2027-11-01', 'Month 24 — mid vesting', 'linear', '810,277,778', '81.03%'],
  ['2028-05-01', 'Team & Private/Seed fully vested', 'linear', '920,833,333', '92.08%'],
  ['2028-11-01', 'Fully vested — Ecosystem & Treasury complete', 'final', '1,000,000,000', '100.00%'],
]

const UTILITY = [
  { t: 'Autonomous Markets Access', d: 'Settlement and access token for the autonomous markets desk — live edges across major sports leagues, commodities and equities.' },
  { t: 'Asset Protection Ledger', d: 'Immutable on-chain accounting bridging TradFi integrity with DeFi transparency for protected, auditable balances.' },
  { t: 'AI-Agent Labor Tracking', d: 'Every autonomous agent action is recorded as a verifiable ledger entry — transparent attribution of machine labor.' },
  { t: 'Governance', d: 'Token-weighted voting over treasury deployment, desk parameters and protocol upgrades through transparent proposals.' },
  { t: 'Staking', d: 'Stake $LDGR to underwrite desk liquidity and earn a share of protocol revenue distributed from realized edges.' },
  { t: 'Fee Burn', d: 'A portion of desk settlement fees is permanently burned on-chain — deflationary against the fixed 1B supply.' },
]

const ENDPOINTS = [
  ['https://api.thepark.world/ldgr/supply', 'JSON'],
  ['https://api.thepark.world/ldgr/circulating-supply', 'TEXT'],
  ['https://api.thepark.world/ldgr/total-supply', 'TEXT'],
]

const WALLETS = [
  ['Team & Advisors Vesting', 'LDGRtea m1Vestv7Pd9xQk4Zr2Lw8Hc3Nf6Sb1Aa9Vault'],
  ['Treasury / Foundation', 'LDGRtre as2Fnd8Qm5xRt6Yv3Kp9Hd4Nc7Sb2Bb8Vault'],
  ['Private / Seed Vesting', 'LDGRsee d3Prv9Wn6xSt7Zw4Lq8He5Md9Nd8Sb3Cc7Vault'],
  ['Ecosystem Emissions', 'LDGReco s4Eco0Xp7xTu8Ax5Mr9If6Ne0Oe9Sb4Dd6Vault'],
]

const API_EXAMPLE = `{
  "ticker": "LDGR",
  "chain": "solana",
  "mint": "7VCPGGaKqeVjtLEe4o4gJUb8Je3ZZm8UA3aB9S3dpump",
  "totalSupply": 1000000000,
  "circulatingSupply": 441666667,
  "lockedSupply": 558333333,
  "source": "on-chain totalSupply() minus verified locked wallets"
}`

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-400 uppercase">
      ▌▌▌ {children}
    </p>
  )
}

export default function TokenomicsPage() {
  return (
    <main id="top" className="relative min-h-dvh w-full bg-[#0a0c14] text-slate-100 selection:bg-amber-500/30 selection:text-amber-100 overflow-x-hidden">
      <div
        className="pointer-events-none fixed inset-0 -z-20 opacity-30"
        style={{
          backgroundImage:
            'linear-gradient(rgba(245,158,11,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(245,158,11,0.06) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />

      <header
        className="relative z-20 flex items-center justify-between px-5 sm:px-8 py-4 border-b-2 border-amber-500/15"
        style={{ paddingTop: 'max(16px, env(safe-area-inset-top))' }}
      >
        <Link
          href="/"
          className="font-mono text-[10px] tracking-[0.32em] text-amber-500/80 uppercase hover:text-amber-300 transition-colors"
        >
          ← back to home
        </Link>
        <span className="font-mono text-[10px] tracking-[0.32em] text-amber-500/80 uppercase">
          ▓ parksystems · corp
        </span>
      </header>

      {/* Hero */}
      <section className="relative z-10 px-5 sm:px-8 pt-12 sm:pt-20 pb-12 sm:pb-16 max-w-7xl mx-auto">
        <Eyebrow>immutable ledger infrastructure · solana</Eyebrow>
        <h1 className="mt-3 text-[clamp(2.6rem,9vw,6.5rem)] font-black tracking-tight leading-[0.9] uppercase text-white">
          $ldgr<br />
          <span className="text-amber-400">tokenomics.</span>
        </h1>
        <p className="mt-6 max-w-3xl text-base sm:text-lg text-slate-400 leading-relaxed">
          $LDGR is the rebar. The yard and the yield are the structure poured around it.
          A fixed 1,000,000,000 supply on Solana — verifiable on-chain, no mint authority,
          every locked wallet published. This page is the transparency record.
        </p>
        <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-px bg-amber-500/20 border-2 border-amber-500/30">
          {METRICS.map((m) => (
            <div key={m.k} className="bg-[#0a0c14] p-4">
              <div className="font-mono text-[10px] tracking-[0.28em] uppercase text-slate-500">{m.k}</div>
              <div className="mt-2 font-mono text-lg sm:text-xl font-black text-amber-400">{m.v}</div>
              <div className="mt-1 font-mono text-[10px] tracking-[0.18em] uppercase text-slate-600">{m.sub}</div>
            </div>
          ))}
        </div>
        <div className="mt-8">
          <ContractCopy />
        </div>
      </section>

      {/* Allocation */}
      <section className="relative z-10 border-t-2 border-amber-500/30 bg-amber-500/[0.04]">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-14 sm:py-20">
          <Eyebrow>token allocation</Eyebrow>
          <h2 className="mt-3 text-[clamp(2rem,6vw,4rem)] font-black tracking-tight leading-[0.95] uppercase text-white">
            five buckets.<br /><span className="text-amber-400">one fixed supply.</span>
          </h2>
          <p className="mt-5 max-w-2xl text-sm sm:text-base text-slate-400 leading-relaxed">
            Fixed supply of 1,000,000,000 $LDGR allocated across five transparent buckets. Legend sums to 100%.
          </p>
          <div className="mt-10">
            <AllocationDonut />
          </div>
        </div>
      </section>

      {/* Vesting & release */}
      <section className="relative z-10 border-t-2 border-amber-500/30">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-14 sm:py-20">
          <Eyebrow>token release schedule</Eyebrow>
          <h2 className="mt-3 text-[clamp(2rem,6vw,4rem)] font-black tracking-tight leading-[0.95] uppercase text-white">
            vesting &amp; <span className="text-amber-400">release.</span>
          </h2>
          <p className="mt-5 max-w-2xl text-sm sm:text-base text-slate-400 leading-relaxed">
            The verifiable circulating-supply emission curve. All schedules are enforced on-chain and publicly auditable.
          </p>

          <div className="mt-10 grid gap-px bg-amber-500/20 border-2 border-amber-500/30 sm:grid-cols-3">
            {VESTING_FACTS.map((f) => (
              <div key={f.k} className="bg-[#0a0c14] p-5">
                <div className="font-mono text-[10px] tracking-[0.28em] uppercase text-slate-500">{f.k}</div>
                <div className="mt-2 font-black uppercase text-white">{f.v}</div>
                <div className="mt-1 text-xs text-slate-500">{f.sub}</div>
              </div>
            ))}
          </div>

          <div className="mt-8 border-2 border-amber-500/30 p-4 sm:p-6">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <h3 className="font-mono text-[11px] tracking-[0.28em] uppercase text-amber-300">
                circulating supply growth — 36-month projection
              </h3>
              <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-slate-500">
                tge 2025-11-01 → 2028-11-01
              </span>
            </div>
            <div className="mt-6">
              <SupplyChart />
            </div>
          </div>

          <div className="mt-8 grid gap-px bg-amber-500/20 border-2 border-amber-500/30 sm:grid-cols-2 lg:grid-cols-4">
            {TIMELINE.map((p) => (
              <div key={p.m} className="bg-[#0a0c14] p-5">
                <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-slate-500">{p.m}</div>
                <div className="mt-2 font-black uppercase text-white">{p.t}</div>
                <div className="mt-1 text-xs text-slate-400">{p.d}</div>
              </div>
            ))}
          </div>

          <div className="mt-8 border-2 border-amber-500/30 overflow-x-auto">
            <table className="w-full font-mono text-[11px] sm:text-xs">
              <thead>
                <tr className="text-left tracking-[0.18em] uppercase text-amber-500/70 border-b-2 border-amber-500/30">
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Milestone</th>
                  <th className="px-4 py-3 text-right">Released</th>
                  <th className="px-4 py-3 text-right">Cumulative</th>
                  <th className="px-4 py-3 text-right">% Supply</th>
                </tr>
              </thead>
              <tbody>
                {UNLOCKS.map((r, i) => (
                  <tr
                    key={r[0]}
                    className={i === UNLOCKS.length - 1
                      ? 'border-t-2 border-amber-500/30 bg-amber-500/[0.04]'
                      : 'border-b border-amber-500/10'}
                  >
                    <td className="px-4 py-3.5 text-slate-300">{r[0]}</td>
                    <td className="px-4 py-3.5 text-slate-400">{r[1]}</td>
                    <td className="px-4 py-3.5 text-right text-amber-300">{r[2]}</td>
                    <td className={`px-4 py-3.5 text-right ${i === UNLOCKS.length - 1 ? 'font-bold text-amber-400' : 'text-white'}`}>{r[3]}</td>
                    <td className={`px-4 py-3.5 text-right ${i === UNLOCKS.length - 1 ? 'font-bold text-amber-400' : 'text-slate-400'}`}>{r[4]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Utility */}
      <section className="relative z-10 border-t-2 border-amber-500/30 bg-amber-500/[0.04]">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-14 sm:py-20">
          <Eyebrow>value capture</Eyebrow>
          <h2 className="mt-3 text-[clamp(2rem,6vw,4rem)] font-black tracking-tight leading-[0.95] uppercase text-white">
            utility &amp; <span className="text-amber-400">mechanics.</span>
          </h2>
          <p className="mt-5 max-w-3xl text-sm sm:text-base text-slate-400 leading-relaxed">
            <span className="text-slate-200">$LDGR powers the desk</span> — an autonomous markets operation with
            live edges across NFL, NBA, MLB, NHL, commodities &amp; stocks. A Solana immutable ledger bridging
            TradFi accounting integrity with DeFi: verifiable infrastructure for asset protection, global
            transactions, and transparent AI-agent labor tracking.
          </p>
          <div className="mt-10 grid gap-px bg-amber-500/20 border-2 border-amber-500/30 sm:grid-cols-2 lg:grid-cols-3">
            {UTILITY.map((u) => (
              <div key={u.t} className="bg-[#0a0c14] p-6">
                <div className="font-mono text-[11px] tracking-[0.28em] uppercase text-amber-300">{u.t}</div>
                <p className="mt-3 text-sm text-slate-400 leading-relaxed">{u.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Transparency / API */}
      <section className="relative z-10 border-t-2 border-amber-500/30">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-14 sm:py-20">
          <Eyebrow>transparency</Eyebrow>
          <h2 className="mt-3 text-[clamp(2rem,6vw,4rem)] font-black tracking-tight leading-[0.95] uppercase text-white">
            programmatic<br /><span className="text-amber-400">source of truth.</span>
          </h2>
          <p className="mt-5 max-w-3xl text-sm sm:text-base text-slate-400 leading-relaxed">
            Circulating supply is calculated in real time from the contract&rsquo;s on-chain
            <span className="text-amber-300"> totalSupply()</span> minus the balances of all locked / vesting
            wallets — so aggregators always see verified, tamper-proof data.
          </p>

          <div className="mt-10 grid gap-6 lg:grid-cols-5">
            <div className="border-2 border-amber-500/30 p-6 sm:p-8 lg:col-span-3">
              <h3 className="font-mono text-[11px] tracking-[0.28em] uppercase text-amber-300">live supply api</h3>
              <p className="mt-2 text-sm text-slate-400">Public, no-auth, CDN-cached. Plain-text endpoints for aggregator ingestion.</p>
              <div className="mt-5 space-y-3">
                {ENDPOINTS.map(([url, kind]) => (
                  <div key={url} className="flex items-center justify-between gap-3 border-2 border-amber-500/20 px-4 py-3">
                    <code className="font-mono text-xs sm:text-sm text-amber-300 break-all">{url}</code>
                    <span className="shrink-0 font-mono text-[10px] tracking-[0.2em] uppercase text-slate-500">{kind}</span>
                  </div>
                ))}
              </div>
              <div className="mt-6">
                <div className="mb-2 font-mono text-[10px] tracking-[0.28em] uppercase text-slate-500">
                  example — GET /ldgr/supply
                </div>
                <pre className="overflow-x-auto border-2 border-amber-500/20 p-4 font-mono text-xs sm:text-sm text-slate-300">{API_EXAMPLE}</pre>
              </div>
            </div>

            <div className="space-y-6 lg:col-span-2">
              <div className="border-2 border-amber-500/30 p-6">
                <h3 className="font-mono text-[11px] tracking-[0.28em] uppercase text-amber-300">verified locked / vesting wallets</h3>
                <p className="mt-2 text-xs text-slate-500">Balances subtracted from circulating supply.</p>
                <ul className="mt-4 space-y-3">
                  {WALLETS.map(([label, addr]) => (
                    <li key={label} className="border-2 border-amber-500/15 p-3">
                      <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-slate-500">{label}</div>
                      <div className="mt-1 font-mono text-xs break-all text-amber-300">{addr}</div>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="border-2 border-amber-500/30 p-6">
                <h3 className="font-mono text-[11px] tracking-[0.28em] uppercase text-amber-300">audit &amp; source</h3>
                <div className="mt-4 grid grid-cols-2 gap-3 font-mono text-[11px] tracking-[0.18em] uppercase">
                  {[
                    ['Solscan', 'https://solscan.io/token/7VCPGGaKqeVjtLEe4o4gJUb8Je3ZZm8UA3aB9S3dpump'],
                    ['Contract', 'https://solscan.io/token/7VCPGGaKqeVjtLEe4o4gJUb8Je3ZZm8UA3aB9S3dpump#code'],
                    ['GitHub', 'https://github.com/parksystemscorporation/lila'],
                    ['Supply API', 'https://api.thepark.world/ldgr/supply'],
                  ].map(([label, href]) => (
                    <a
                      key={label}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between border-2 border-amber-500/20 px-3 py-2.5 text-slate-300 hover:border-amber-300 hover:text-white transition-colors"
                    >
                      <span>{label}</span><span className="text-amber-400">↗</span>
                    </a>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-8 border-2 border-amber-500/30 bg-amber-500/[0.04] p-5 text-center text-sm text-slate-400">
            <span className="font-bold text-amber-400">Note:</span> All supply metrics are read directly from the
            Solana blockchain. Vesting schedules are publicly auditable.
          </div>
        </div>
      </section>

      {/* CTA back to the desk */}
      <section className="relative z-10 border-y-2 border-amber-500/30 bg-amber-500/[0.04]">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-12 sm:py-16 flex flex-wrap items-center justify-between gap-6">
          <div>
            <Eyebrow>see what it underwrites</Eyebrow>
            <p className="mt-3 text-2xl sm:text-3xl font-black tracking-tight uppercase text-white">
              the yard &amp; <span className="text-amber-400">the yield.</span>
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/infoyard"
              className="inline-flex items-center gap-2 border-2 border-amber-500/40 hover:border-amber-300 text-amber-300 hover:text-white px-5 py-3 font-mono text-[10px] tracking-[0.32em] uppercase transition-colors"
            >
              how the desk works →
            </Link>
            <Link
              href="/"
              className="inline-flex items-center gap-2 bg-amber-400 hover:bg-amber-300 text-black px-5 py-3 border-2 border-amber-300 font-mono text-[10px] tracking-[0.32em] uppercase transition-colors"
            >
              enter the park →
            </Link>
          </div>
        </div>
      </section>

      <footer className="relative z-10 px-5 sm:px-8 py-10 max-w-7xl mx-auto">
        <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-slate-600 leading-relaxed">
          $LDGR is an infrastructure utility token. This page is provided for transparency and is not financial advice.
        </p>
      </footer>
    </main>
  )
}
