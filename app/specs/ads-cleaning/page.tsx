import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Lila · Running Costs',
  description: 'What you pay each month to operate Lila for your cleaning-service Facebook ads.',
}

// Public handoff info sheet. Single screenshotable page. No marketing.
// Just the recurring bills the new operator will see on their card each
// month, and who's charging them.

export default function RunningCosts() {
  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100 font-mono antialiased">
      <div className="max-w-xl mx-auto px-6 py-10 space-y-8">
        {/* Mark */}
        <div className="text-center">
          <pre className="text-emerald-600/80 text-[10px] leading-tight whitespace-pre select-none">
{`▓▒░ PARKSYSTEMS CORPORATION ░▒▓`}
          </pre>
          <p className="text-[9px] tracking-[0.3em] text-slate-700 mt-2 uppercase">
            Operator Handoff · Monthly Running Costs
          </p>
        </div>

        {/* Title */}
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold text-white tracking-tight">Lila</h1>
          <p className="text-xs text-slate-500">
            Facebook ad automation for your cleaning service
          </p>
        </div>

        {/* What you'll pay */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-4">
          <p className="text-[10px] text-slate-500 uppercase tracking-widest">
            What hits your card each month
          </p>

          <Bill
            who="Railway"
            what="Hosting for the app + small Postgres database"
            range="$10–$20"
            how="Billed monthly, charges the card you add during setup. Usage-based — small accounts stay near the low end."
          />

          <Bill
            who="DeepSeek"
            what="AI API (how Lila reads, writes, and replies)"
            range="$20–$50"
            how="Prepaid credits. You top up $20–$50 at a time and it draws down as Lila works. Heavy comment traffic pushes toward the high end."
          />

          <Bill
            who="Meta"
            what="Facebook / Instagram ad budget"
            range="Your call"
            how="Whatever you decide to spend on ads goes directly from your card to Meta. Lila doesn't spend it — she just optimizes how it's spent. Most small cleaners start at $15–$30/day."
          />

          <Bill
            who="Meta Graph API"
            what="Read/write access for the bot"
            range="Free"
            how="No charge for the API itself — just the ad budget above. Meta keeps API access free for Page/Ads permissions."
            free
          />

          <Bill
            who="Domain (optional)"
            what="Custom URL if you want one"
            range="$12–$15/year"
            how="Roughly $1/mo amortized. Skip it and use the Railway-provided URL at no cost."
          />
        </div>

        {/* Summary line */}
        <div className="rounded-2xl border border-emerald-900/60 bg-emerald-950/30 p-5 space-y-2">
          <p className="text-[10px] text-emerald-500 uppercase tracking-widest">
            Bottom line
          </p>
          <p className="text-xs text-slate-200 leading-relaxed">
            Expect <span className="text-emerald-400 font-semibold">$30–$70/month</span>{' '}
            in fixed operating bills (Railway + DeepSeek). Everything else scales
            with the ad budget you choose to run.
          </p>
        </div>

        {/* Setup notes */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-3">
          <p className="text-[10px] text-slate-500 uppercase tracking-widest">Where you log in to pay</p>
          <ul className="text-xs text-slate-400 space-y-2 leading-snug">
            <li className="flex gap-2">
              <span className="text-slate-600 shrink-0">→</span>
              <span><span className="text-slate-200">railway.com</span> — account under your email, card on file. Lila lives here.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-slate-600 shrink-0">→</span>
              <span><span className="text-slate-200">platform.deepseek.com</span> — top up credits. No subscription, pay-as-you-go.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-slate-600 shrink-0">→</span>
              <span><span className="text-slate-200">business.facebook.com</span> — your ad account + card for ad spend.</span>
            </li>
          </ul>
          <p className="text-[10px] text-slate-600 pt-2 leading-relaxed">
            All three are yours. PARKSystems Corporation does not see your cards,
            does not receive any of these payments, and does not continue charging
            you after handoff.
          </p>
        </div>

        {/* Footer */}
        <div className="text-center space-y-1 pt-2">
          <p className="text-[10px] text-slate-600 tracking-widest uppercase">
            PARKSystems Corporation · Operator Handoff Sheet · 2026
          </p>
        </div>
      </div>
    </div>
  )
}

function Bill({
  who, what, range, how, free,
}: {
  who: string
  what: string
  range: string
  how: string
  free?: boolean
}) {
  return (
    <div className="flex items-start gap-3 py-2 border-t border-slate-800 first:border-t-0 first:pt-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm text-white font-semibold">{who}</p>
          <p className={`text-sm tabular-nums shrink-0 ${free ? 'text-emerald-400' : 'text-slate-200'}`}>
            {range}
          </p>
        </div>
        <p className="text-[11px] text-slate-500 leading-snug mt-0.5">{what}</p>
        <p className="text-[10px] text-slate-600 leading-snug mt-1.5">{how}</p>
      </div>
    </div>
  )
}
