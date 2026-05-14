// Public explainer for the bounty pipeline. Sub-$500 GitHub bounties from
// Gitcoin and Algora, drafted by Scout, vetted by Lila, submitted by the
// company GitHub bot. Voice mirrors the rest of the site: dry, numbers-
// first, no exclamation points. Static — no live data, no API fetches.

import Link from 'next/link'
import { TONE } from '@/app/_components/strategy/tone'
import type { Tone } from '@/app/_components/strategy/copy'

interface FleetMember {
  name: string
  role: string
  blurb: string
  cadence: string
  tone: Tone
}

const FLEET: FleetMember[] = [
  {
    name: 'LILA',
    role: 'desk manager · review gate',
    blurb: 'Runs the team. Vets every Scout draft and Cipher report before anything leaves the desk. Voice: direct, lowercase-first, no hedging.',
    cadence: 'every priority tick',
    tone: 'amber',
  },
  {
    name: 'CEELO',
    role: 'NFL · NBA · MLB handicapper',
    blurb: 'Elo ratings vs the live book line. No LLM in the picks path — the math is deterministic. Voice: math-first, terse, no fluff.',
    cadence: '30-min cycle',
    tone: 'red',
  },
  {
    name: 'VEGA',
    role: 'equities + commodity ETFs',
    blurb: 'Watchlists, news scans, tight stops. Real tickers only — never invents positions. Voice: technical, decisive.',
    cadence: 'time-gated',
    tone: 'orange',
  },
  {
    name: 'CIPHER',
    role: 'security-bounty executor',
    blurb: 'Three steps every 30s gate: parse the operator task, run the audit, post status. Files reports for Lila to vet.',
    cadence: 'every 30s gate',
    tone: 'red',
  },
  {
    name: 'SCOUT',
    role: 'volume bounty hunter',
    blurb: 'Sub-$500 GitHub bounties from Gitcoin + Algora. Drafts the title, body, and unified diff; Lila reviews before submit.',
    cadence: '5-min gate',
    tone: 'amber',
  },
]

interface DispatchRow {
  step: number
  loop: string
  cadence: string
  blurb: string
  head?: boolean
}

const DISPATCH: DispatchRow[] = [
  { step:  1, loop: 'TradingEngine',          cadence: 'every tick',     blurb: 'position monitoring, tight stops' },
  { step:  2, loop: 'AnalystLoop · Vega',     cadence: 'time-gated',     blurb: 'equities + commodity ETFs' },
  { step:  3, loop: 'TaskerLoop · Cipher',    cadence: 'time-gated',     blurb: 'security audits, files reports' },
  { step:  4, loop: 'ScoutLoop',              cadence: '5-min gate',     blurb: 'fetches Gitcoin + Algora, drafts PRs' },
  { step:  5, loop: 'AutonomyLoop · Lila',    cadence: 'priority-gated', blurb: 'reviews, replies, desk approvals', head: true },
  { step:  6, loop: 'DmLoop',                 cadence: 'one DM / tick',  blurb: 'answers a queued marketplace DM' },
  { step:  7, loop: 'CeeloLoop',              cadence: '30-min cycle',   blurb: 'thoroughbred yield engine, no LLM' },
  { step:  8, loop: 'DiscoveryLoop',          cadence: 'daily',          blurb: 'protocol + repo scan' },
  { step:  9, loop: 'BroadcastLoop',          cadence: 'intervaled',     blurb: 'Bluesky posts' },
]

interface PipelineState {
  state: string
  actor: string
  what: string
  tone: Tone
}

const PIPELINE: PipelineState[] = [
  { state: 'discovered', actor: 'Scout S0',         what: "fetched from Gitcoin or Algora, dedup'd by (source, external_id), inserted into bounty_picks.", tone: 'orange' },
  { state: 'drafted',    actor: 'Scout S1',         what: 'DeepSeek writes draft_title + draft_body (200–600 words, markdown) + draft_diff (unified, 3-line context). 2k-token cap.', tone: 'orange' },
  { state: 'approved',   actor: 'Lila',             what: 'BOUNTY_REVIEW_PROMPT vets truthfulness, diff plausibility, scope match. One-shot decision.', tone: 'amber' },
  { state: 'submitted',  actor: 'github-pr.ts',     what: 'fork upstream → sync → branch → apply hunks via Contents API → open PR from the bot account.', tone: 'amber' },
  { state: 'paid',       actor: 'platform',         what: 'paid_amount_usd recorded.', tone: 'red' },
]

const SOURCES: { name: string; url: string; cap: string; filter: string; tone: Tone }[] = [
  { name: 'GITCOIN', url: 'gitcoin.co/api/v1/bounties', cap: '≤ $500 USDT', filter: "idx_status=open · project_length=Hours,Days · GitHub-resolvable only", tone: 'orange' },
  { name: 'ALGORA',  url: 'console.algora.io/api/v1/bounties', cap: '≤ $500 USD', filter: "status=open · reward_type=cash · GitHub-resolvable only", tone: 'amber' },
]

const ANTI: string[] = [
  'Lila never claims "we made $X" from a submission, an approval, or a finding. Only money the operator has actually received counts.',
  "Ceelo's picks have no LLM in the path. Elo ratings + book-line diff, deterministic. No model hallucinations in the picks.",
  "Vega never invents a ticker. If it is not in the context block, it is not in the note.",
  'Scout will not touch bounties over $500 or non-GitHub repos. The filter is hard — the operator can override, the loop will not.',
  'Broadcasts have no hashtags, no emojis, no exclamation points. The voice is "dry, numbers-first, quant-trained" or it does not ship — the model outputs the literal word SKIP.',
]

export default function BountyPage() {
  return (
    <main className="min-h-dvh w-full bg-[#0a0c14] text-slate-100 selection:bg-amber-500/30 selection:text-amber-100">
      <div
        className="pointer-events-none fixed inset-0 -z-10 opacity-40"
        style={{
          backgroundImage:
            'linear-gradient(rgba(245,158,11,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(245,158,11,0.06) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />

      <header className="sticky top-0 z-30 border-b-2 border-amber-500/20 bg-[#0a0c14]/85 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-3 flex items-center justify-between">
          <Link href="/" className="group flex items-center gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            <span className="font-mono text-[10px] tracking-[0.32em] text-amber-500/80 uppercase group-hover:text-amber-300 transition-colors">
              ▓ park · bounty
            </span>
          </Link>
          <Link href="/" className="font-mono text-[10px] tracking-[0.32em] text-slate-500 hover:text-amber-300 uppercase transition-colors">
            ← thepark.world
          </Link>
        </div>
      </header>

      <section className="relative border-b-2 border-amber-500/20 overflow-hidden">
        <div
          className="absolute inset-0 -z-10 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse at 30% 20%, rgba(245,158,11,0.10), transparent 55%), radial-gradient(ellipse at 70% 80%, rgba(251,146,60,0.06), transparent 55%)',
          }}
        />
        <div className="mx-auto max-w-7xl px-4 sm:px-8 pt-10 sm:pt-16 pb-10 sm:pb-16">
          <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase">
            ▌▌▌ how it works
          </p>
          <h1 className="mt-3 text-[clamp(2.2rem,7vw,4.4rem)] font-black tracking-tight leading-[0.92] uppercase">
            <span className="text-amber-400">BOUNTY</span>
            <span className="text-slate-500"> hunting, in the open.</span>
          </h1>
          <p className="mt-5 max-w-2xl text-sm sm:text-base text-slate-400 leading-relaxed">
            Sub-$500. GitHub-resolvable. Two sources. One review gate. Five agents on a 30-second tick — and a desk manager who runs them.
          </p>
        </div>
      </section>

      <section className="border-b-2 border-amber-500/20">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-10 sm:py-14">
          <div className="flex items-baseline justify-between gap-4 mb-5 sm:mb-8">
            <div>
              <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase">
                ▌▌▌ five seats
              </p>
              <h2 className="mt-2 text-[clamp(1.6rem,5vw,3rem)] font-black tracking-tight uppercase text-white">
                the <span className="text-amber-400">desk</span>.
              </h2>
            </div>
            <p className="hidden sm:block font-mono text-[10px] tracking-[0.3em] text-slate-500 uppercase max-w-[16rem] text-right">
              one head<br />four sub-agents
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-4">
            {FLEET.map((m, i) => <FleetTile key={m.name} m={m} index={i} />)}
          </div>
        </div>
      </section>

      <section className="border-b-2 border-amber-500/20">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-10 sm:py-14">
          <div className="flex items-baseline justify-between gap-4 mb-5 sm:mb-8">
            <div>
              <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase">
                ▌▌▌ one tick
              </p>
              <h2 className="mt-2 text-[clamp(1.6rem,5vw,3rem)] font-black tracking-tight uppercase text-white">
                the <span className="text-amber-400">dispatch</span>.
              </h2>
              <p className="mt-3 max-w-xl text-sm text-slate-400 leading-relaxed">
                Every 30 seconds, one entry point fans out to the fleet. Each loop logs what it touched and returns. The order is fixed; the gates are not.
              </p>
            </div>
            <p className="hidden sm:block font-mono text-[10px] tracking-[0.3em] text-slate-500 uppercase max-w-[16rem] text-right">
              agent-tick.ts<br />server-side ticker
            </p>
          </div>

          <div className="border-2 border-amber-500/20 bg-slate-950/40 divide-y divide-amber-500/10">
            {DISPATCH.map((row) => <DispatchRow key={row.step} row={row} />)}
          </div>
        </div>
      </section>

      <section className="border-b-2 border-amber-500/20">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-10 sm:py-14">
          <div className="flex items-baseline justify-between gap-4 mb-5 sm:mb-8">
            <div>
              <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase">
                ▌▌▌ where the bounties live
              </p>
              <h2 className="mt-2 text-[clamp(1.6rem,5vw,3rem)] font-black tracking-tight uppercase text-white">
                two <span className="text-amber-400">sources</span>.
              </h2>
              <p className="mt-3 max-w-2xl text-sm text-slate-400 leading-relaxed">
                Both are unauthenticated public endpoints. Scout fetches every hour, dedups against what is already in the queue, and only keeps GitHub-resolvable bounties.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            {SOURCES.map((s) => <SourceTile key={s.name} s={s} />)}
          </div>
        </div>
      </section>

      <section className="border-b-2 border-amber-500/20">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-10 sm:py-14">
          <div className="flex items-baseline justify-between gap-4 mb-5 sm:mb-8">
            <div>
              <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase">
                ▌▌▌ scout, drafted, vetted
              </p>
              <h2 className="mt-2 text-[clamp(1.6rem,5vw,3rem)] font-black tracking-tight uppercase text-white">
                the <span className="text-amber-400">pipeline</span>.
              </h2>
              <p className="mt-3 max-w-2xl text-sm text-slate-400 leading-relaxed">
                Five states in <span className="font-mono text-amber-300">bounty_picks.status</span>. Each one is a database row anyone with operator access can audit.
              </p>
            </div>
          </div>

          <div className="border-2 border-amber-500/20 bg-slate-950/40 divide-y divide-amber-500/10">
            {PIPELINE.map((p, i) => <PipelineRow key={p.state} p={p} step={i + 1} />)}
          </div>
        </div>
      </section>

      <section className="border-b-2 border-amber-500/20">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-10 sm:py-14">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 sm:gap-7">
            <PromptCard
              kicker="▌▌▌ scout · the draft prompt"
              title="JSON only."
              body={[
                'Bindings: SOURCE, TITLE, REWARD, REPO, ISSUE_NUMBER, LABELS, LANGUAGE, DIFFICULTY, BODY, TREE (60 file paths max).',
                'Output: draft_title + draft_body (200–600 words, markdown, "Closes #N") + draft_diff (unified, 3-line context, a/ b/ prefixes) + files_touched + confidence (0.0–1.0).',
                'Token cap: 2,000 combined for body + diff. Model: DeepSeek Chat — $0.27 / $1.10 per million in/out. Daily LLM budget gate stops the loop if the bill is too high.',
                'Confidence calibration: ≥0.8 means the diff applies cleanly. 0.5–0.8 means spirit correct but may need adjustment. <0.5 means uncertain — Scout still drafts, Lila still has the call.',
              ]}
              tone="orange"
            />
            <PromptCard
              kicker="▌▌▌ lila · the review gate"
              title="One-shot decision."
              body={[
                'Reads the draft against the original bounty body and the linked GitHub issue. Looks for three things: truthfulness, diff plausibility, scope match.',
                'Approve → status flips to approved, GitHub PR submitter picks it up next tick (if LILA_AUTO_SUBMIT and a GITHUB_TOKEN are set). Reject → status flips to rejected, the cycle skips it.',
                'No revisions. No "let me reword the body." If the draft is wrong, it is rejected and Scout drafts a new one next pass. The review is a gate, not an editor.',
                'Lila posts the approval to operator chat with the bounty title and reward.',
              ]}
              tone="amber"
            />
          </div>
        </div>
      </section>

      <section className="border-b-2 border-amber-500/20">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-10 sm:py-14">
          <div className={`border-2 border-red-500/40 bg-slate-950/70 p-6 sm:p-8`}>
            <p className="font-mono text-[10px] tracking-[0.45em] uppercase text-red-300">
              ▌ what the desk won&rsquo;t do
            </p>
            <ul className="mt-4 space-y-3">
              {ANTI.map((line, i) => (
                <li key={i} className="flex gap-3">
                  <span className="font-mono text-[11px] text-red-300 mt-0.5">×</span>
                  <p className="font-mono text-[11px] sm:text-[12px] leading-relaxed text-slate-300">{line}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <footer className="bg-slate-950/40">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-7 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <Link
            href="/"
            className="group flex items-center gap-3 font-mono text-[11px] tracking-[0.32em] text-amber-500 uppercase hover:text-amber-300 transition-colors"
          >
            <span className="text-2xl leading-none transition-transform group-hover:-translate-x-0.5">←</span>
            thepark.world
          </Link>
          <span className="font-mono text-[9px] tracking-[0.3em] text-slate-700 uppercase">
            autonomous · bounty desk · v1
          </span>
        </div>
      </footer>
    </main>
  )
}

function FleetTile({ m, index }: { m: FleetMember; index: number }) {
  const t = TONE[m.tone]
  return (
    <div className={`border-2 ${t.border} bg-slate-950/70 p-4 sm:p-5 transition-all duration-300 ${t.ring}`}>
      <div className="flex items-center justify-between mb-3">
        <span className={`font-mono text-[10px] tracking-[0.32em] uppercase ${t.accent}`}>
          #{index + 1} · seat
        </span>
        <span
          className="w-1.5 h-1.5 rounded-full animate-pulse"
          style={{ backgroundColor: t.hex, boxShadow: `0 0 8px ${t.hex}` }}
        />
      </div>

      <div className={`text-[clamp(1.6rem,4vw,2.4rem)] font-black tracking-tight uppercase text-white leading-[0.95] ${t.glow}`}>
        {m.name}
      </div>

      <p className={`mt-2 font-mono text-[10px] tracking-wider uppercase ${t.accent}`}>
        {m.role}
      </p>

      <p className="mt-3 font-mono text-[10px] sm:text-[11px] leading-relaxed text-slate-400 line-clamp-4">
        {m.blurb}
      </p>

      <div className={`mt-4 border-t ${t.borderSoft} pt-3 flex items-baseline justify-between gap-2`}>
        <span className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-500">cadence</span>
        <span className={`font-mono text-[10px] tabular-nums ${t.accent} truncate`}>{m.cadence}</span>
      </div>
    </div>
  )
}

function DispatchRow({ row }: { row: DispatchRow }) {
  const accent = row.head ? 'text-amber-300' : 'text-slate-400'
  const stepColor = row.head ? 'text-amber-400' : 'text-slate-600'
  return (
    <div className={`grid grid-cols-[2.5rem_1fr_6rem] sm:grid-cols-[3rem_1fr_2fr_8rem] gap-3 items-baseline px-4 sm:px-5 py-3 ${row.head ? 'bg-amber-500/[0.04]' : ''}`}>
      <span className={`font-mono text-[11px] tabular-nums font-black ${stepColor}`}>{String(row.step).padStart(2, '0')}</span>
      <span className={`font-mono text-[11px] sm:text-[12px] font-bold tracking-wide uppercase ${accent} truncate`}>{row.loop}</span>
      <span className="hidden sm:block font-mono text-[11px] text-slate-500 leading-snug">{row.blurb}</span>
      <span className="font-mono text-[10px] tracking-[0.25em] uppercase text-slate-500 text-right truncate">{row.cadence}</span>
    </div>
  )
}

function SourceTile({ s }: { s: { name: string; url: string; cap: string; filter: string; tone: Tone } }) {
  const t = TONE[s.tone]
  return (
    <div className={`border-2 ${t.border} bg-slate-950/70 p-5 sm:p-6 ${t.ring}`}>
      <div className="flex items-baseline justify-between mb-3">
        <span className={`font-mono text-[10px] tracking-[0.32em] uppercase ${t.accent}`}>source</span>
        <span className={`font-mono text-[9px] tracking-[0.32em] uppercase tabular-nums ${t.accent}`}>{s.cap}</span>
      </div>

      <div className={`text-[clamp(1.8rem,4vw,2.6rem)] font-black tracking-tight uppercase text-white leading-[0.95] ${t.glow}`}>
        {s.name}
      </div>

      <p className="mt-3 font-mono text-[10px] sm:text-[11px] tracking-wider text-slate-500 truncate">
        {s.url}
      </p>

      <div className={`mt-4 border-t ${t.borderSoft} pt-3`}>
        <p className="font-mono text-[10px] tracking-[0.32em] uppercase text-slate-500 mb-2">filter</p>
        <p className="font-mono text-[11px] leading-relaxed text-slate-300">{s.filter}</p>
      </div>
    </div>
  )
}

function PipelineRow({ p, step }: { p: PipelineState; step: number }) {
  const t = TONE[p.tone]
  return (
    <div className="grid grid-cols-[2.5rem_1fr_2fr] sm:grid-cols-[3rem_8rem_1fr_2fr] gap-3 items-baseline px-4 sm:px-5 py-4">
      <span className={`font-mono text-[11px] tabular-nums font-black ${t.accent}`}>{String(step).padStart(2, '0')}</span>
      <span className={`font-mono text-[11px] sm:text-[12px] font-bold tracking-wider uppercase ${t.accent} truncate`}>{p.state}</span>
      <span className="hidden sm:block font-mono text-[10px] tracking-[0.32em] uppercase text-slate-500 truncate">{p.actor}</span>
      <span className="font-mono text-[11px] leading-relaxed text-slate-400">{p.what}</span>
    </div>
  )
}

function PromptCard({ kicker, title, body, tone }: { kicker: string; title: string; body: string[]; tone: Tone }) {
  const t = TONE[tone]
  return (
    <div className={`border-2 ${t.border} bg-slate-950/70 p-5 sm:p-7`}>
      <p className={`font-mono text-[10px] sm:text-[11px] tracking-[0.45em] uppercase ${t.accent}`}>{kicker}</p>
      <h3 className="mt-2 text-[clamp(1.4rem,4vw,2rem)] font-black tracking-tight uppercase text-white">
        {title}
      </h3>
      <ul className={`mt-4 space-y-3 border-l-2 ${t.borderSoft} pl-4`}>
        {body.map((line, i) => (
          <li key={i} className="font-mono text-[11px] sm:text-[12px] leading-relaxed text-slate-300">
            {line}
          </li>
        ))}
      </ul>
    </div>
  )
}
