// /help — onboarding for the two-room model (yield + yard) plus the
// derivative math that lives on the yield floor. Linked from the red HELP
// slab in every member footer.

'use client'

import { LocalShell } from '@/app/_components/local/chrome'

export default function HelpPage() {
  return (
    <LocalShell
      title="HELP"
      subtitle="two rooms. two reads."
      accent="amber"
      back={{ href: '/', label: 'back to home' }}
    >
      <div className="mx-auto max-w-4xl px-5 sm:px-8 py-8 sm:py-12 space-y-8 sm:space-y-12">

        <Section kicker="how the park reads" title="ten-second start">
          <ol className="space-y-3 font-mono text-[12px] sm:text-[13px] leading-relaxed text-slate-300 list-decimal list-inside">
            <li>
              <em className="not-italic text-amber-300">/theyield</em> — sports + horse racing.
              live edges on book lines. derivative math only: implied prob, synthetic hold, yield-after-vig.
              steam + delta tell you when to look.
            </li>
            <li>
              <em className="not-italic text-amber-300">/theyard</em> — vega&rsquo;s commodity board.
              today&rsquo;s calls only. long-only etfs and macro. wipes at 00:00 utc.
              entry, target, stop, confidence, one-sentence reason.
            </li>
            <li>
              spend park gates on a dm via <em className="not-italic text-amber-300">/marketplace</em> when
              you want a human read from lila, vega, or ceelo.
            </li>
          </ol>
          <p className="mt-5 font-mono text-[11px] tracking-[0.18em] uppercase text-slate-500 leading-relaxed">
            rest of this page is the formula sheet. keep it open while you learn the room.
          </p>
        </Section>

        <Section kicker="who works the desk" title="the room hands">
          <DefList rows={[
            ['vega',  'analyst · commodity etfs + global macro. lives on /theyard. long-only, tight stops, real tickers. wipes daily.'],
            ['ceelo', 'handicapper · nfl / nba / mlb. lives in /theyield. elo + book-line, deterministic, no llm in the picks path.'],
            ['lila',  'desk manager. vets every call before it leaves the desk. dms cost park gates.'],
          ]} />
        </Section>

        <Section kicker="the yard · vega" title="what the board shows">
          <p className="text-sm text-slate-300 leading-relaxed mb-4">
            each card is a single trade idea. symbol, direction (always long), entry / target / stop in
            tabular numbers, a confidence pip from 0 to 1, a risk chip (low / medium / high), and one
            sentence of why.
          </p>
          <p className="text-sm text-slate-400 leading-relaxed">
            the board fills as vega ticks. empty until she calls the open. resets to empty at 00:00 utc —
            yesterday&rsquo;s calls don&rsquo;t carry over.
          </p>
          <div className="mt-5">
            <DefList rows={[
              ['scope',    'commodity etfs, leveraged s&p / nq, global macro. no biotech. no retail. no penny.'],
              ['direction','long-only. vega does not short.'],
              ['cadence',  'picks land when the analyst loop ticks. board polls every 30s.'],
              ['reset',    '00:00 utc — destructive wipe in the retention pass.'],
            ]} />
          </div>
        </Section>

        <Section kicker="the yield · sports + horse racing" title="data sources">
          <DefList rows={[
            ['sharp anchor',      'api-sports (pinnacle / circa feeds) → ground truth.'],
            ['retail sensor',     'parlayapi (draftkings / fanduel / mgm) → the lagging price.'],
            ['sentiment bridge',  'action pro (ticket & money %) → whale vs. herd.'],
            ['prediction market', 'prophetx / polymarket → peer-to-peer truth.'],
          ]} />
        </Section>

        <Section kicker="the yield · intensity 1–10" title="velocity & the gap">
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

        <Section kicker="the yield · math" title="implied prob, hold, yield">
          <p className="text-sm text-slate-400 leading-relaxed mb-5">
            the yield floor doesn&rsquo;t guess. these are derivatives of the book line — implied prob and
            hold are functions of what the book is showing, not opinions about the game.
          </p>
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

        <Section kicker="the yield · icons" title="what the icons mean">
          <DefList rows={[
            ['public gravity',  'retail line − sharp line.'],
            ['the whale',       'money % − ticket %.'],
            ['the lock',        'triggers when h < 0 (arbitrage).'],
            ['velocity arrow',  'triggers when steam level ≥ 7.'],
          ]} />
        </Section>

        <Section kicker="execution protocol · yield-side" title="how the live edges run">
          <p className="text-sm text-slate-400 leading-relaxed mb-5">
            yield picks are live edges, not pre-set trades. yard picks already ship with entry / target /
            stop — they don&rsquo;t need this protocol.
          </p>
          <DefList rows={[
            ['live-on-sight',   'data is processed in ram / redis with a 60-second ttl. nothing is persisted, to stay inside upstream tos.'],
            ['signal-first ui', 'raw odds are hidden to prevent redistribution bans — you see derivative icons and intensity levels only.'],
          ]} />
        </Section>

        <Section kicker="anti-rules" title="what the desk will not do">
          <ul className="space-y-2 text-sm text-slate-300 leading-relaxed list-disc list-inside">
            <li>vega never invents a ticker. if it isn&rsquo;t in her context block, it isn&rsquo;t on the board.</li>
            <li>the yard wipes at midnight utc. yesterday&rsquo;s calls are gone, on purpose.</li>
            <li>no claims of realized p&amp;l unless the operator has actually received the money.</li>
            <li>the yield&rsquo;s math is derivative — implied prob and hold are functions of the book line, not opinions.</li>
            <li>lowercase-first. no exclamation points. no hashtags. no emojis.</li>
          </ul>
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
