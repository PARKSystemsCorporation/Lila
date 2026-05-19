'use client'

import Link from 'next/link'

const TELEGRAM_URL = 'https://t.me/+B2cQQXxTZwk1YTFh'

// Fire-and-forget conversion event. One per session per (event,ref) pair
// so reload-mashing doesn't inflate counts.
function track(event: string, ref?: string) {
  if (typeof window === 'undefined') return
  const k = `pw_track:${event}:${ref ?? ''}`
  try {
    if (window.sessionStorage.getItem(k)) return
    window.sessionStorage.setItem(k, '1')
  } catch { /* private mode etc — still send once */ }
  fetch('/api/public/landing-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, ref }),
    keepalive: true,
  }).catch(() => {})
}

const BULLETS = [
  'Free-to-play rooms via utility credits',
  'Real-time crypto redemptions',
  'Multiplayer degen energy',
]

export default function PublicLanding() {
  return (
    <main
      id="top"
      className="relative min-h-dvh w-full overflow-x-hidden text-slate-100 selection:bg-amber-500/30 selection:text-amber-100"
      style={{
        background:
          'radial-gradient(ellipse at 30% 12%, rgba(245,181,26,0.13), transparent 55%),' +
          'radial-gradient(ellipse at 78% 78%, rgba(245,181,26,0.07), transparent 55%),' +
          'linear-gradient(180deg, #0c0e16 0%, #07080d 100%)',
      }}
    >
      {/* Brutalist grid wash */}
      <div
        className="pointer-events-none fixed inset-0 z-0 opacity-50"
        style={{
          backgroundImage:
            'linear-gradient(rgba(245,181,26,0.045) 1px, transparent 1px),' +
            'linear-gradient(90deg, rgba(245,181,26,0.045) 1px, transparent 1px)',
          backgroundSize: '46px 46px',
        }}
      />

      {/* Content column — the mockup screen, made responsive */}
      <div className="relative z-10 mx-auto flex min-h-dvh w-full max-w-[460px] flex-col sm:border-x sm:border-amber-500/10">
        {/* App bar */}
        <header
          className="flex items-center justify-between border-b-2 border-black/25 px-5 py-3.5"
          style={{
            background: 'linear-gradient(180deg, #f5b51a 0%, #e0a312 100%)',
            paddingTop: 'max(14px, env(safe-area-inset-top))',
          }}
        >
          <div className="flex items-baseline gap-[7px] font-mono font-bold text-[#0a0c14]">
            <span className="text-[21px] tracking-[-0.5px]">$PARK</span>
            <span className="text-[8px] leading-[1.05] tracking-[0.18em] opacity-75">
              PARK
              <br />
              CASINO
            </span>
          </div>
          <Link
            href="/tokenomics"
            className="font-mono text-[11px] font-bold tracking-[0.16em] text-[#0a0c14]"
          >
            TOKENOMICS&nbsp;&rarr;
          </Link>
        </header>

        {/* Stat strip */}
        <div className="flex items-stretch border-b border-amber-500/20 bg-[#050609]">
          <div className="flex-1 px-2 py-3.5 text-center font-mono text-[12px] font-bold tracking-[0.22em] text-amber-500">
            EDGES OPEN&nbsp;&bull;&nbsp;0
          </div>
          <div className="w-px bg-amber-500/20" />
          <div className="flex-1 px-2 py-3.5 text-center font-mono text-[12px] font-bold tracking-[0.22em] text-amber-500">
            PICKS SETTLED&nbsp;&bull;&nbsp;0
          </div>
        </div>

        {/* Corp row */}
        <div className="flex items-center justify-between border-b border-amber-500/15 bg-[#050609]/60 px-5 py-[18px]">
          <div className="flex items-center gap-[11px]">
            <svg
              className="h-[34px] w-[34px] text-amber-500"
              viewBox="0 0 32 32"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 28h26" />
              <path d="M5 28V13l11-8 11 8v15" />
              <path d="M13 28v-9a3 3 0 0 1 6 0v9" />
            </svg>
            <div className="leading-[1.05]">
              <div className="text-[15px] font-black tracking-[0.03em] text-white">
                PARKSYSTEMS
              </div>
              <div className="font-mono text-[9px] tracking-[0.34em] text-amber-500">
                CORP
              </div>
            </div>
          </div>
          <Link
            href="/login"
            className="whitespace-nowrap rounded-[10px] border border-amber-500/50 px-[13px] py-[9px] font-mono text-[11px] font-bold tracking-[0.12em] text-amber-500"
            style={{
              background:
                'linear-gradient(180deg, rgba(245,181,26,0.14), rgba(245,181,26,0.04))',
            }}
          >
            LOCAL SIGN IN&nbsp;&rarr;
          </Link>
        </div>

        {/* Hero */}
        <section className="px-6 pb-[30px] pt-[38px]">
          <div className="mb-3.5 font-mono text-[12px] font-bold tracking-[0.42em] text-amber-500">
            WELCOME TO
          </div>
          <h1 className="mb-[26px] text-[clamp(3rem,15vw,62px)] font-black uppercase leading-[0.92] tracking-[-1.5px]">
            <span className="block text-white">THE PARK</span>
            <span
              className="block bg-clip-text text-transparent"
              style={{
                backgroundImage:
                  'linear-gradient(95deg, #f5b51a 0%, #ffd766 55%, #c9890c 100%)',
              }}
            >
              CASINO
            </span>
          </h1>
          <div
            className="mb-[26px] h-1 w-16 rounded"
            style={{
              background: 'linear-gradient(90deg, #f5b51a, transparent)',
            }}
          />

          <p className="mb-[22px] text-[19px] font-medium leading-[1.45] text-[#e7e9ef]">
            Live multiplayer sweepstakes rooms, slots-style action, and real
            crypto prize redemptions — all free-to-play.
          </p>

          <p className="mb-[30px] text-[15px] leading-[1.5] text-[#9aa0ad]">
            Built on secure custody and treasury infrastructure. No purchase
            necessary.
          </p>

          <ul className="mb-9 list-none">
            {BULLETS.map((b) => (
              <li
                key={b}
                className="flex items-center gap-[13px] border-b border-white/5 py-[13px] text-[16px] font-semibold text-[#eef0f4]"
              >
                <span
                  className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full text-[#0a0c14]"
                  style={{
                    background: 'linear-gradient(180deg, #f5b51a, #d99a0c)',
                  }}
                >
                  <svg
                    className="h-[14px] w-[14px]"
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 10l4 4 8-9" />
                  </svg>
                </span>
                {b}
              </li>
            ))}
          </ul>

          <a
            href={TELEGRAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => track('tg_join_click', 'park_casino')}
            className="mb-4 flex w-full items-center justify-center gap-2.5 rounded-2xl px-5 py-[21px] text-[19px] font-extrabold tracking-[0.04em] text-[#0a0c14]"
            style={{
              background:
                'linear-gradient(180deg, #ffd23f 0%, #f5b51a 55%, #e0a312 100%)',
              boxShadow: '0 14px 34px -10px rgba(245,181,26,0.6)',
            }}
          >
            JOIN THE TELEGRAM GROUP&nbsp;&rarr;
          </a>
          <a
            href={TELEGRAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="block break-all rounded-[10px] border border-dashed border-amber-500/30 px-3.5 py-[11px] text-center font-mono text-[13px] text-[#aeb3bf]"
          >
            {TELEGRAM_URL}
          </a>
        </section>

        {/* Footer + sweepstakes disclosure */}
        <footer
          className="mt-auto border-t border-white/[0.06] px-6 pt-6 text-center"
          style={{ paddingBottom: 'max(40px, env(safe-area-inset-bottom))' }}
        >
          <p className="mx-auto mb-3 max-w-[40ch] text-[11px] leading-[1.6] text-[#8b8f9b]">
            <span className="font-bold text-[#9aa0ad]">
              NO PURCHASE NECESSARY.
            </span>{' '}
            A purchase or payment will not improve your chances of winning. Open
            only to legal residents of{' '}
            <span className="text-[#7c818d]">[eligible jurisdictions]</span> who
            are 18+ (or the age of majority in their jurisdiction). Void where
            prohibited.
          </p>

          <details className="mx-auto mb-5 max-w-[42ch] text-left">
            <summary className="cursor-pointer list-none text-center font-mono text-[11px] uppercase tracking-[0.22em] text-amber-500/80">
              Sweepstakes Rules ▾
            </summary>
            <div className="mt-3 space-y-2.5 text-[11px] leading-[1.6] text-[#7c818d]">
              <p>
                <span className="text-[#9aa0ad]">1. Sponsor.</span> PARKSystems
                Corporation (&ldquo;Sponsor&rdquo;).
              </p>
              <p>
                <span className="text-[#9aa0ad]">
                  2. No Purchase Necessary.
                </span>{' '}
                No purchase or payment of any kind is necessary to enter or win.
                A purchase or payment will not improve your chances of winning.
              </p>
              <p>
                <span className="text-[#9aa0ad]">3. Eligibility.</span> Open only
                to legal residents of [eligible jurisdictions] who are at least
                18 years of age (or the age of majority in their jurisdiction,
                and 21+ where required for the applicable prize). Employees of
                Sponsor and their immediate family or household members are not
                eligible. Void where prohibited or restricted by law.
              </p>
              <p>
                <span className="text-[#9aa0ad]">
                  4. Free Method of Entry.
                </span>{' '}
                Eligible participants may enter and play free-to-play rooms using
                utility credits at no cost; full details are provided in-product.
              </p>
              <p>
                <span className="text-[#9aa0ad]">5. Prizes.</span> Prizes consist
                of crypto prize redemptions and are subject to availability and
                applicable law. Winners are solely responsible for all applicable
                taxes and any wallet/custody requirements. Prizes are
                non-transferable; no cash substitution except at Sponsor&rsquo;s
                sole discretion.
              </p>
              <p>
                <span className="text-[#9aa0ad]">6. Odds.</span> Odds of winning
                depend on the number and eligibility of entries received and
                participation.
              </p>
              <p>
                <span className="text-[#9aa0ad]">
                  7. No Third-Party Sponsorship.
                </span>{' '}
                This promotion is not sponsored, endorsed, administered by, or
                associated with Apple Inc., Telegram, or any other third-party
                platform.
              </p>
              <p>
                <span className="text-[#9aa0ad]">8. General.</span> All decisions
                of the Sponsor are final. This promotion is subject to all
                applicable federal, state, and local laws and regulations and is
                void where prohibited.
              </p>
              <p>
                <span className="text-[#9aa0ad]">9. Contact.</span> Questions may
                be directed to the Sponsor via the official Telegram channel
                linked above.
              </p>
            </div>
          </details>

          <div className="font-mono text-[11px] tracking-[0.06em] text-[#565b66]">
            &copy; PARKSystems Corporation
          </div>
        </footer>
      </div>
    </main>
  )
}
