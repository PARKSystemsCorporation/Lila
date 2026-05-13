// /help — onboarding for new members plus the raw framework spec
// (data sources, intensity scales, EV math, derivative mapping, execution
// protocol). The "I've signed up, now what?" entry point linked from the
// red HELP slab in every member footer.

'use client'

import { LocalShell } from '@/app/_components/local/chrome'

export default function HelpPage() {
  return (
    <LocalShell
      title="HELP"
      subtitle="I've signed up, now what?"
      accent="amber"
      back={{ href: '/', label: 'back to home' }}
    >
      <div className="mx-auto max-w-4xl px-5 sm:px-8 py-8 sm:py-12 space-y-8 sm:space-y-12">

        <Section kicker="getting started" title="ten-second start">
          <ol className="space-y-3 font-mono text-[12px] sm:text-[13px] leading-relaxed text-slate-300 list-decimal list-inside">
            <li>Pick your floor at <em className="not-italic text-amber-300">/theyield</em> — Sports or Commodities.</li>
            <li>Read the board. The signals are <em className="not-italic text-amber-300">derivatives</em>, not raw odds — the icons and intensity levels do the talking.</li>
            <li>Trust the lock. When the synthetic hold goes negative the room calls it. You don&rsquo;t need to do the math.</li>
            <li>Spend your monthly Park Gates on a DM to the desk via <em className="not-italic text-amber-300">/marketplace</em> when you want a human read.</li>
          </ol>
          <p className="mt-5 font-mono text-[11px] tracking-[0.18em] uppercase text-slate-500 leading-relaxed">
            The rest of this page is the formula sheet — keep it open while you learn the room.
          </p>
        </Section>

        <Section kicker="data sources" title="the stack">
          <DefList rows={[
            ['Sharp Anchor',     'API-Sports (Pinnacle / Circa feeds) → ground truth.'],
            ['Retail Sensor',    'ParlayAPI (DraftKings / FanDuel / MGM) → the lagging price.'],
            ['Sentiment Bridge', 'Action Pro (ticket & money %) → whale vs. herd.'],
            ['Prediction Market','ProphetX / Polymarket → peer-to-peer truth.'],
          ]} />
        </Section>

        <Section kicker="intensity framework · 1–10" title="velocity & the gap">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-5">
            <SubCard title="Steam Intensity (Velocity)" body="Sharp line movement over a 120-second window.">
              <Levels rows={[
                ['L10', '$0.25+', 'Solar flare'],
                ['L7',  '$0.07 – $0.09', 'Action threshold'],
                ['L1–3','<$0.02', 'Noise'],
              ]} />
            </SubCard>
            <SubCard title="Delta Intensity (the Gap)" body="Price difference between Sharp Anchor and Retail Sensor.">
              <Levels rows={[
                ['L10', '$0.30+', 'Arbitrage'],
                ['L7',  '$0.15 – $0.19', 'Core yield target'],
                ['L1–3','<$0.04', 'Market equilibrium'],
              ]} />
            </SubCard>
          </div>
        </Section>

        <Section kicker="mathematical formulas" title="the math">
          <Formula title="Implied Probability (P)">
{`Negative odds:  P = abs(Odds) / (abs(Odds) + 100)
Positive odds:  P = 100 / (Odds + 100)`}
          </Formula>
          <Formula title="Synthetic Hold (H)">
{`H = (Σ Pᵢ) − 1
    where Σ is the sum of probabilities for all outcomes (i = 1..n)`}
          </Formula>
          <Formula title="The Yield (EV)">
{`Yield = (1 / Implied_Prob_Sharp) − (1 / Implied_Prob_Retail)`}
          </Formula>
        </Section>

        <Section kicker="ui derivative mapping" title="what the icons mean">
          <DefList rows={[
            ['Public Gravity', 'Retail Line − Sharp Line.'],
            ['The Whale',      'Money % − Ticket %.'],
            ['The Lock',       'Triggers when H < 0 (arbitrage).'],
            ['Velocity Arrow', 'Triggers when Steam Level ≥ 7.'],
          ]} />
        </Section>

        <Section kicker="execution protocol" title="how the room runs">
          <DefList rows={[
            ['Live-on-Sight', 'Data is processed in RAM / Redis with a 60-second TTL. Nothing is persisted, to stay inside the upstream ToS.'],
            ['Signal-First UI', 'Raw odds are hidden to prevent redistribution bans — you see the derivative icons and intensity levels only.'],
          ]} />
        </Section>

      </div>
    </LocalShell>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────

function Section({ kicker, title, children }: { kicker: string; title: string; children: React.ReactNode }) {
  return (
    <section className="border-2 border-amber-500/15 bg-slate-950/60 p-5 sm:p-7">
      <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] uppercase text-amber-500/80">
        ▌▌▌ {kicker}
      </p>
      <h2 className="mt-2 text-[clamp(1.4rem,4vw,2rem)] font-black tracking-tight uppercase text-white">
        {title}
      </h2>
      <div className="mt-5">{children}</div>
    </section>
  )
}

function SubCard({ title, body, children }: { title: string; body: string; children: React.ReactNode }) {
  return (
    <div className="border border-amber-500/20 bg-slate-950/70 p-4 sm:p-5">
      <h3 className="font-mono text-[10px] sm:text-[11px] tracking-[0.32em] uppercase text-amber-300">
        {title}
      </h3>
      <p className="mt-2 text-xs sm:text-sm text-slate-400 leading-relaxed">{body}</p>
      <div className="mt-4">{children}</div>
    </div>
  )
}

function DefList({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="divide-y divide-slate-800">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-1 sm:gap-5 py-3">
          <dt className="font-mono text-[10px] sm:text-[11px] tracking-[0.32em] uppercase text-amber-300">{k}</dt>
          <dd className="text-sm text-slate-300 leading-relaxed">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function Levels({ rows }: { rows: [string, string, string][] }) {
  return (
    <ul className="space-y-2">
      {rows.map(([level, threshold, label]) => (
        <li key={level} className="grid grid-cols-[42px_minmax(0,1fr)_auto] gap-3 items-baseline">
          <span className="font-mono text-[11px] tracking-[0.32em] uppercase text-amber-400 tabular-nums">{level}</span>
          <span className="font-mono text-sm text-white tabular-nums">{threshold}</span>
          <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-slate-500">{label}</span>
        </li>
      ))}
    </ul>
  )
}

function Formula({ title, children }: { title: string; children: string }) {
  return (
    <div className="mb-4 last:mb-0">
      <h3 className="font-mono text-[10px] sm:text-[11px] tracking-[0.32em] uppercase text-amber-300 mb-2">
        {title}
      </h3>
      <pre className="border border-amber-500/20 bg-[#0a0c14] p-3 sm:p-4 overflow-x-auto font-mono text-[12px] sm:text-[13px] leading-relaxed text-slate-200 whitespace-pre">
{children}
      </pre>
    </div>
  )
}
