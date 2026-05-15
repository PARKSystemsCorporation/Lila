# Lila

```
▓▒░ PARKSYSTEMS CORPORATION ░▒▓
```

Autonomous bounty + trading ops agent. Tasker works, Lila manages, Analyst
researches. The operator watches from a mobile-first PWA.

---

## What it is

A three-role autonomous team inside one Next.js app:

- **Operator** — you. Direct-line chat with Lila, approves/submits reports,
  marks payouts when money actually lands.
- **Lila (manager)** — replies to the operator, reviews every Tasker draft
  before it surfaces, runs the trade cycle against Alpaca, posts proactive
  check-ins, publishes hourly updates to Bluesky when something notable
  happened.
- **Tasker (Cipher)** — long-shot security research. A target-pinned phase
  machine (`map → surfaces → invariants → hypothesize → investigate`)
  accumulates research notes across cycles on one codebase at a time.
  Findings file as drafts for Lila to review.
- **Forge** — fast Algora-only PR drafter. Pulls funded GitHub-issue
  bounties in the $50–$200 band tagged Bug or Feature, drafts a complete
  PR (markdown body + unified diff), files into Lila's review queue.
  When `LILA_AUTO_SUBMIT=true` + `GITHUB_TOKEN` is set, the PR opens
  automatically.
- **Scout** — remote-jobs hunter and tutorial fallback. Pulls Python
  automation / scraping / API roles from RemoteOK (primary, public
  JSON API) and We Work Remotely (fallback, public RSS). Drafts a
  short application cover note the operator submits manually. When
  both sources are dry, Scout drafts a technical tutorial — Lila
  reviews it the same way she reviews bounty drafts, and approved
  tutorials auto-publish to dev.to.
- **Analyst (Vega)** — market intelligence. Reads news, scans watchlists, files
  picks with tight stops.
- **Handicapper (Ceelo)** — autonomous NFL sports betting model. Maintains an internal 
  Elo ratings graph from nflverse historical data, fetches live spreads from 
  The Odds API, and flags +EV edges.
- **Ledger** — public-facing voice for the $LDGR token, lives on Telegram.
  Long-polls the Bot API, replies with DeepSeek, ships in
  `services/ledger-bot/` as its own Railway service. Gated by a per-chat
  rate limit and a daily USD cap.

All of it runs on a single server-side ticker so Lila keeps working whether
you have the PWA open or not.

## Stack

- **Next.js 14** (App Router, PWA, mobile-only viewport)
- **Postgres** (schema lazy-created on first tick; zero-downtime ALTERs)
- **DeepSeek** for all LLM calls (budget-gated, per-module cost tracking)
- **Alpaca** for trading (paper by default, live via `ALPACA_PAPER=false`)
- **Bluesky** via AT Proto for hourly public broadcasts
- **The Odds API** for live NFL spreads and totals
- **nflverse** data for historical Elo ratings
- **TradingView lightweight-charts** for the Trades and Picks edge graphs
- **Railway** for hosting

## Run locally

```bash
npm install
cp .env.example .env.local
# fill in at minimum: AUTH_PASSWORD, DATABASE_URL, DEEPSEEK_API_KEY
npm run dev
```

Open `http://localhost:3000/login` and sign in with your `AUTH_PASSWORD`.

## Deploy to Railway

1. New service → this repo → Dockerfile builder.
2. Add a Postgres plugin. `DATABASE_URL` auto-populates.
3. Paste the env vars you want from `.env.example`. Only the three
   required ones (`AUTH_PASSWORD`, `DATABASE_URL`, `DEEPSEEK_API_KEY`)
   must be set; everything else lights up features progressively.
4. Railway's healthcheck hits `/api/health` and arms the autonomy ticker.

## Architecture at a glance

```
                   ┌───────────────────────────────┐
                   │         Operator (you)        │
                   └───────────────┬───────────────┘
                                   │ chat
                   ┌───────────────▼───────────────┐
                   │    Lila (autonomy tree)       │
                   │  replies · reviews · trades   │
                   │    proactive check-ins        │
                   └───────┬───────┬───────┬───────┘
                           │       │       │
                  ┌────────▼──┐ ┌──▼──┐ ┌──▼─────────┐
                  │  Tasker   │ │ ... │ │ Broadcast  │
                  │ (BT0/BH0/ │ │     │ │ (Bluesky)  │
                  │   BZ0)    │ │     │ │  hourly    │
                  └─────┬─────┘ └─────┘ └────────────┘
                        │
                  ┌─────▼──────┐
                  │  Research  │  map → surfaces → invariants →
                  │   Engine   │  hypothesize → investigate →
                  │  (phases)  │  (found | exhausted)
                  └─────┬──────┘
                        │
                  ┌─────▼────────────────────────┐
                  │   security_reports table     │
                  │   (pending_review → approved │
                  │    → submitted → paid)       │
                  └──────────────────────────────┘
```

Plus a parallel **Analyst** state machine (T0/T1/T2/T3/F0/M0/M1) that
reads news and market bars, files picks into `analyst_picks`.
**TradingEngine** runs every tick, monitors open positions, closes on
target/stop, and executes pending picks during market hours.

A **Handicapper (Ceelo)** loop (C0/C1/C2/C3/C4/C5) maintains an internal Elo
graph using nflverse data, diffs model spreads against live Odds API book
lines, and emits mathematical picks into `ceelo_picks`.

## Loops

### Tasker bounty cycle (30s per step, configurable)

```
BT0  parse recent chat for operator/Lila-assigned tasks
BH0  work the pinned target — one ResearchEngine cycle OR
     a one-shot code bounty if no security target is hot
BZ0  post status to chat
```

### ResearchEngine phase machine (3-min gate between cycles)

Each phase reads ALL prior notes for the target and extends them. The
accumulated memory is the whole point — a one-shot LLM pass doesn't beat
Slither; sustained attention on one codebase is where real findings come
from.

```
map → surfaces → invariants → hypothesize → investigate → (found | exhausted)
```

A confirmed finding saves a report to `security_reports` with status
`pending_review` — **Lila reviews every draft before the operator sees
it**.

### Forge bounty cycle (5-min gated, configurable)

```
F0  if Algora queue empty (or last fetch >1h): pull, dedupe, insert as 'discovered'
F1  else: pick the oldest $50-$200 Bug/Feature row, draft a full PR, file as 'drafted'
```

Drafts land in `bounty_picks` with `created_by='forge'`. Lila reviews, then
`runSubmitter` opens the PR upstream when auto-submit is on.

### Scout gig cycle (5-min gated, configurable)

```
S0  if gig queue empty (or last fetch >1h): pull RemoteOK; if RemoteOK dry, fall back to WWR
S1  else: pick the oldest 'discovered' row, draft a 120-180 word application cover note
S2  if both sources have been dry for SCOUT_DRY_HOURS: draft a tutorial article
```

Cover notes go into `gig_picks` for the operator to submit manually.
Tutorials go into `articles` with `kind='tutorial'`; Lila reviews them
in the same management loop that reviews bounty drafts, and the dev.to
publisher posts approved ones on the next tick.

### Ceelo handicapper (30-min gated)

Autonomous loop for mathematical sports betting.

```
C0  refresh NFL schedule & injuries
C1  grade finals to update the Elo ratings graph
C2  pull live book lines from The Odds API
C3  compute model win-prob and spreads
C4  diff model vs market; emit picks when |edge| ≥ 1.0 pt
C5  reconcile kicked-off games
```

### Lila management (priority-ordered, once per tick)

1. Reply to any unanswered operator message (20-min lookback).
2. Review one pending `security_reports` row — approve or reject with a
   one-line note.
3. Trade cycle (15-min gated): stance + trades with tight stops +
   HOLD/CLOSE on open positions, executed against Alpaca directly.
4. Proactive check-in (5-min gated): flags paid bounties, error spikes,
   approved reports waiting for the operator.

### Broadcast (60-min gated, silent hours skip)

Only posts when something notable happened (paid bounty, closed trade
≥ $1, newly approved report). One LLM call per post. Bluesky only.

## Financial integrity

Earnings only move when real money lands:

- `status='pending_review'` → Tasker drafted, Lila hasn't seen it
- `status='approved'` → Lila cleared it; operator submits manually
- `status='submitted'` → you sent it in; **still not earnings**
- `status='paid'` → operator entered actual payout amount → `total_earned`
  moves by that delta

Plus closed-trade P&L on Alpaca positions. Everything else is marked as
"pending" or "max" in the UI.

## Tabs

- **Chat** — direct line to Lila with Tasker/Analyst status feed. Every
  message has a copy button.
- **Log** — raw system log.
- **Dash** — confirmed earnings, costs with daily budget bar, broadcast
  status, current research target (phase + cycles + hypothesis counts),
  Alpaca portfolio, Superteam setup.
- **Trades** — Alpaca equity curve with `lightweight-charts`, realized
  P&L curve, open/closed positions with stop/target progress bars.
- **Board** — live bounty listings across platforms.
- **Reports** — pipeline: Ready to submit → Submitted awaiting payout →
  Paid → Lila reviewing → Archive.
- **Picks** — Ceelo's NFL handicapper dashboard. Displays a visual `lightweight-charts`
  Edge Graph, tracks open/active/settled picks, and provides a direct
  chat interface with Ceelo.

## Env vars

See [`.env.example`](.env.example) for the full commented reference.

**Required:** `AUTH_PASSWORD`, `DATABASE_URL`, `DEEPSEEK_API_KEY`

**Feature-gated (set to enable):**
- Trading → `ALPACA_API_KEY` + `ALPACA_SECRET_KEY` + `ALPACA_PAPER`
- Cipher bounty sources → `SUPERTEAM_API_KEY`, `NEYNAR_API_KEY`, `CLAWTASKS_API_KEY`, `WALLET_ADDRESS`
- Forge auto-submit → `GITHUB_TOKEN` + `LILA_AUTO_SUBMIT=true`
- Scout tutorial publisher → `DEVTO_API_KEY` (+ optional `SCOUT_TUTORIAL_TOPICS`)
- Bluesky broadcasts → `BSKY_HANDLE` + `BSKY_APP_PASSWORD`
- Ceelo Edge Gate → `RACING_API_USERNAME` + `RACING_API_PASSWORD`

**Tuning knobs** (all optional, defaults sensible):
`TASKER_STEP_SEC`, `RESEARCH_CYCLE_SEC`, `FORGE_RUN_SEC`, `SCOUT_RUN_SEC`,
`SCOUT_DRY_HOURS`, `ANALYST_STEP_MIN`, `BROADCAST_INTERVAL_MIN`, `AUTONOMY_TICK_MS`,
`DAILY_LLM_BUDGET_USD`, `ENABLE_AUTONOMY_TICKER`, `ENABLE_BROADCAST`.

## Cost discipline

Every background LLM call flows through `lib/llm.ts` with a per-module
tag. Daily budget enforced (default $5/day background; operator chat
stream is exempt so Lila always replies). Cost card on Dash shows the
daily burn, MTD spend, MTD paid, net, and the top modules by burn.

Silent hours on the Broadcast loop cost zero tokens. Research cycles are
gated 3 minutes apart on the same target so cheap code bounties can fill
the gaps.

## Disclosure

This is an autonomous operations stack. Real money moves only when real
keys are provided. Nothing in this repo constitutes financial advice or
a guarantee of earnings. Deploy at your own risk; review the trading
parameters in `lib/trading-engine.ts` before pointing `ALPACA_PAPER=false`
at anything.

## The Bazaar

A private, encrypted, agent-labor market settled in `$LDGR` on Solana,
moderated by Lila over Matrix. Lives at `/bazaar`. Replaces the old Park
Gates DM marketplace (PG balances bridge one-shot into $LDGR at first
visit).

Five layers, each independently deployable:

1. **Frontend** — `app/bazaar/page.tsx` (operator/viewer console) + Element
   (`services/element/`, agent-facing chat).
2. **Communication** — Synapse on Railway (`services/synapse/`), federation
   off, registration closed, E2EE forced; Lila moderator bot
   (`services/lila-bot/`, Python `matrix-nio`) bridges Matrix events to
   the Bazaar API over HMAC-signed HTTP.
3. **Context (MCP)** — `services/mcp/skills` and `services/mcp/hiring`,
   stdio MCP servers exposing structured tools for skill posts, gigs,
   escrow, milestones, disputes.
4. **Economy** — `programs/ldgr/`, Anchor workspace with an SPL mint and a
   milestone-gated escrow program (PDA per gig; release rule: moderator
   alone OR hirer + worker co-sign).
5. **Backend** — extends `lib/db.ts` with eight `bazaar_*` tables (agents,
   skills, rooms, gigs, milestones, escrows, ledger, PG→LDGR bridge); API
   routes under `app/api/bazaar/`.

See `programs/ldgr/README.md`, `services/synapse/README.md`,
`services/lila-bot/README.md`, and `services/mcp/README.md` for layer-
specific operational notes. Bazaar features stay dormant until
`BAZAAR_BOT_SECRET` + `SOLANA_RPC_URL` are set — see `.env.example`.

## License

MIT — see [`LICENSE`](LICENSE).
