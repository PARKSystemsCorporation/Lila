// Per-commodity playbook copy. Single source of truth — every strategy panel
// on /commodities/[root] reads from this file. Voice mirrors Ceelo’s article
// prompt: dry, sharp, numbers-first, no exclamation points.

import type { Strategy, WorkedExample, Tone } from '@/app/_components/strategy/copy'

export type { Strategy, WorkedExample, Tone }

export type Category = 'energy' | 'metals' | 'grains' | 'softs' | 'livestock'

export interface Contract {
  root: string
  name: string
  category: Category
  tone: Tone
  contractSize: number
  contractUnit: string
  tickSize: number
  tickValue: number
  exchange: string
  sessions: string
  headline: boolean
}

export interface Playbook {
  root: string
  name: string
  category: Category
  tone: Tone
  primaryTrade: string
  edgeTrigger: string
  thesis: string
  whereTheEdgeLives: string
  readSignal: { field: string; meaning: string }[]
  primary: Strategy
  sub: Strategy
  anti: string[]
}

const SIGNAL_FIELDS: { field: string; meaning: string }[] = [
  { field: 'contract',          meaning: 'Front-month code Ceelo is reading. Roll math is your problem, not his.' },
  { field: 'tick_value',        meaning: '$ per tick on this contract. Multiply by ticks moved × lots for PnL.' },
  { field: 'front_basis',       meaning: 'Front minus next month, in price units. Negative means contango, positive means backwardation.' },
  { field: 'oi_ratio',          meaning: 'Open interest in front month vs total. >0.55 means crowd is sitting on the front and rolls bite harder.' },
  { field: 'mom_5d',            meaning: 'Five-day price momentum, in ticks. Anchors the trend filter on every trigger.' },
  { field: 'seasonality_score', meaning: 'Normalized seasonal reading, −1 to +1. Background, not a trigger by itself.' },
  { field: 'cot_net',           meaning: 'COT non-commercial net position vs 52-week range. Crowded means crowded.' },
]

export const CONTRACTS: Contract[] = [
  // ENERGY — NYMEX, near-24h electronic session.
  { root: 'CL', name: 'Crude Oil (WTI)',  category: 'energy',    tone: 'orange', contractSize: 1000,  contractUnit: 'barrels',     tickSize: 0.01,    tickValue: 10.00, exchange: 'NYMEX', sessions: 'Sun–Fri 18:00–17:00 ET',                headline: true  },
  { root: 'NG', name: 'Natural Gas',      category: 'energy',    tone: 'orange', contractSize: 10000, contractUnit: 'MMBtu',       tickSize: 0.001,   tickValue: 10.00, exchange: 'NYMEX', sessions: 'Sun–Fri 18:00–17:00 ET',                headline: false },
  { root: 'HO', name: 'NY Heating Oil',   category: 'energy',    tone: 'orange', contractSize: 42000, contractUnit: 'gallons',     tickSize: 0.0001,  tickValue: 4.20,  exchange: 'NYMEX', sessions: 'Sun–Fri 18:00–17:00 ET',                headline: false },

  // METALS — COMEX, near-24h electronic session.
  { root: 'GC', name: 'Gold',             category: 'metals',    tone: 'amber',  contractSize: 100,   contractUnit: 'troy oz',     tickSize: 0.10,    tickValue: 10.00, exchange: 'COMEX', sessions: 'Sun–Fri 18:00–17:00 ET',                headline: true  },
  { root: 'SI', name: 'Silver',           category: 'metals',    tone: 'amber',  contractSize: 5000,  contractUnit: 'troy oz',     tickSize: 0.005,   tickValue: 25.00, exchange: 'COMEX', sessions: 'Sun–Fri 18:00–17:00 ET',                headline: false },
  { root: 'HG', name: 'Copper',           category: 'metals',    tone: 'amber',  contractSize: 25000, contractUnit: 'pounds',      tickSize: 0.0005,  tickValue: 12.50, exchange: 'COMEX', sessions: 'Sun–Fri 18:00–17:00 ET',                headline: false },

  // GRAINS — CBOT, split overnight + day session.
  { root: 'ZC', name: 'Corn',             category: 'grains',    tone: 'amber',  contractSize: 5000,  contractUnit: 'bushels',     tickSize: 0.0025,  tickValue: 12.50, exchange: 'CBOT',  sessions: 'Sun–Fri 19:00–07:45 + 08:30–13:20 CT',  headline: true  },
  { root: 'ZW', name: 'Wheat',            category: 'grains',    tone: 'amber',  contractSize: 5000,  contractUnit: 'bushels',     tickSize: 0.0025,  tickValue: 12.50, exchange: 'CBOT',  sessions: 'Sun–Fri 19:00–07:45 + 08:30–13:20 CT',  headline: false },
  { root: 'ZS', name: 'Soybeans',         category: 'grains',    tone: 'amber',  contractSize: 5000,  contractUnit: 'bushels',     tickSize: 0.0025,  tickValue: 12.50, exchange: 'CBOT',  sessions: 'Sun–Fri 19:00–07:45 + 08:30–13:20 CT',  headline: false },

  // SOFTS — ICE US, daytime electronic session.
  { root: 'KC', name: 'Coffee C',         category: 'softs',     tone: 'red',    contractSize: 37500, contractUnit: 'pounds',      tickSize: 0.0005,  tickValue: 18.75, exchange: 'ICE',   sessions: 'Mon–Fri 04:15–13:30 ET',                headline: true  },
  { root: 'CC', name: 'Cocoa',            category: 'softs',     tone: 'red',    contractSize: 10,    contractUnit: 'metric tons', tickSize: 1,       tickValue: 10.00, exchange: 'ICE',   sessions: 'Mon–Fri 04:45–13:30 ET',                headline: false },
  { root: 'CT', name: 'Cotton No. 2',     category: 'softs',     tone: 'red',    contractSize: 50000, contractUnit: 'pounds',      tickSize: 0.0001,  tickValue: 5.00,  exchange: 'ICE',   sessions: 'Sun–Fri 21:00–14:20 ET',                headline: false },

  // LIVESTOCK — CME, daytime pit-driven session.
  { root: 'LE', name: 'Live Cattle',      category: 'livestock', tone: 'red',    contractSize: 40000, contractUnit: 'pounds',      tickSize: 0.00025, tickValue: 10.00, exchange: 'CME',   sessions: 'Mon–Fri 08:30–13:05 CT',                headline: true  },
  { root: 'GF', name: 'Feeder Cattle',    category: 'livestock', tone: 'red',    contractSize: 50000, contractUnit: 'pounds',      tickSize: 0.00025, tickValue: 12.50, exchange: 'CME',   sessions: 'Mon–Fri 08:30–13:05 CT',                headline: false },
  { root: 'HE', name: 'Lean Hogs',        category: 'livestock', tone: 'red',    contractSize: 40000, contractUnit: 'pounds',      tickSize: 0.00025, tickValue: 10.00, exchange: 'CME',   sessions: 'Mon–Fri 08:30–13:05 CT',                headline: false },
]

export const PLAYBOOKS: Record<'CL' | 'GC' | 'ZC' | 'KC' | 'LE', Playbook> = {
  CL: {
    root: 'CL',
    name: 'Crude Oil (WTI)',
    category: 'energy',
    tone: 'orange',
    primaryTrade: 'front-month outright',
    edgeTrigger: 'front_basis flip with oi_ratio ≥ 0.55',
    thesis: 'WTI term structure overshoots inventory. Front-back basis flips lead spot moves around EIA prints; commercials reset the curve inside three sessions.',
    whereTheEdgeLives:
      'Crude is two markets stitched together — paper around inventory days and physical around Cushing flows. ' +
      'Spec books drive the front basis past where commercials want it; the snap-back happens in the curve before the headline. ' +
      'Read front_basis against mom_5d. When they disagree by more than 1σ, the curve is telling you which one is wrong.',
    readSignal: SIGNAL_FIELDS,
    primary: {
      name: 'Front-spread fade, inventory aware',
      market: 'front-month outright',
      threshold: 'front_basis flip with oi_ratio ≥ 0.55 and confirming mom_5d',
      when:  'When front basis flips backwardation → contango on EIA day while mom_5d is still pointing the other way, fade the move.',
      why:   'The curve resets faster than the screen. Spec longs paid up for the front and have to roll into a worse number; the basis gives you a 1.5–2× R window before they finish.',
      example: {
        game: 'CLM5 — June WTI',
        market: 'front-month outright',
        signal: [
          { label: 'contract',          value: 'CLM5' },
          { label: 'tick_value',        value: '$10.00' },
          { label: 'front_basis',       value: '−0.18 (M5−N5)' },
          { label: 'oi_ratio',          value: '0.58' },
          { label: 'mom_5d',            value: '−22 ticks' },
          { label: 'seasonality_score', value: '+0.32' },
          { label: 'cot_net',           value: '−0.41 (40th pctile)' },
        ],
        math: [
          { label: 'entry',                value: 'long 2 CLM5 at 75.20' },
          { label: 'stop',                 value: '75.02 (18 ticks)' },
          { label: 'target',               value: '75.50 (30 ticks)' },
          { label: 'risk: 2 × $10 × 18',   value: '$360' },
          { label: 'reward: 2 × $10 × 30', value: '$600' },
          { label: 'R',                    value: '1.67' },
        ],
        decision: 'Long 2 CLM5 at 75.20, stop 75.02, work out 75.50.',
        close:    'Settled 75.46 on session.',
        clv:      'CLV +26 ticks vs entry.',
        outcome:  'Illustration: scaled out 75.50 for $600. Cushing draw confirmed Wed; basis flipped back inside two sessions. Illustration · not a track record.',
      },
    },
    sub: {
      name: 'Memorial Day crack-spread fade',
      market: 'front-month outright',
      threshold: '321 crack > 1.5σ over 20-session and seasonality_score > +0.4',
      when:  'Pre-Memorial Day weekend, when refining margins blow out and crude is the cheap leg of the 321.',
      why:   'Refiner hedge flow inflates the product side into driving season. Crude catches up inside five sessions; you do not need to leg the spread to collect that.',
      example: {
        game: 'CLN5 — July WTI',
        market: 'front-month outright',
        signal: [
          { label: 'contract',          value: 'CLN5' },
          { label: 'tick_value',        value: '$10.00' },
          { label: 'front_basis',       value: '+0.42 (N5−Q5)' },
          { label: 'oi_ratio',          value: '0.51' },
          { label: 'mom_5d',            value: '+14 ticks' },
          { label: 'seasonality_score', value: '+0.61' },
          { label: 'cot_net',           value: '+0.18' },
        ],
        math: [
          { label: '321 crack z-score',    value: '+1.73σ' },
          { label: 'entry',                value: 'long 1 CLN5 at 78.40' },
          { label: 'stop',                 value: '78.10 (30 ticks)' },
          { label: 'target',               value: '79.00 (60 ticks)' },
          { label: 'risk: 1 × $10 × 30',   value: '$300' },
          { label: 'reward: 1 × $10 × 60', value: '$600' },
          { label: 'R',                    value: '2.0' },
        ],
        decision: 'Long 1 CLN5 at 78.40, stop 78.10, work to 79.00.',
        close:    'Settled 78.97.',
        clv:      'CLV +57 ticks vs entry.',
        outcome:  'Illustration: filled out at 79.00 for $600. Crack mean-reverted within four sessions. Illustration · not a track record.',
      },
    },
    anti: [
      'Trading the EIA print live. The first two minutes are book noise, not your edge.',
      'Buying contango in size. Negative roll yield bleeds you while you wait to be right.',
      'Stacking CL with RBOB and HO long as a parlay. The correlation is not free — you are triple-stacking the same view.',
      'Adding to losers on round numbers. 70, 80, 90 are not signals, they are where the stops live.',
    ],
  },

  GC: {
    root: 'GC',
    name: 'Gold',
    category: 'metals',
    tone: 'amber',
    primaryTrade: 'front-month outright',
    edgeTrigger: 'mom_5d divergence vs 10y real yield ≥ 1.5σ',
    thesis: 'Gold’s primary driver is 10y real yields. Short-term divergence is sentiment, not signal — and sentiment-driven moves are the ones that revert.',
    whereTheEdgeLives:
      'Gold has two clocks: a slow real-yield clock and a fast positioning clock. Headlines push the fast clock; the slow clock pulls it back. ' +
      'When mom_5d disagrees with the real-yield move by more than 1.5σ, the divergence resolves toward the slow clock 70%+ of the time within five sessions. ' +
      'Read cot_net before sizing — crowded longs are a different trade than crowded shorts.',
    readSignal: SIGNAL_FIELDS,
    primary: {
      name: 'Real-yield divergence fade',
      market: 'front-month outright',
      threshold: 'mom_5d divergence vs 10y real yield ≥ 1.5σ and cot_net top quartile',
      when:  'When gold rallies into rising real yields by more than 1.5σ over 5 sessions and the COT crowd is already long, fade.',
      why:   'Real yields are the primary driver; positioning is the lever that gets pulled when the divergence closes. You are paid to take the side the slow clock will reach.',
      example: {
        game: 'GCM5 — June Gold',
        market: 'front-month outright',
        signal: [
          { label: 'contract',          value: 'GCM5' },
          { label: 'tick_value',        value: '$10.00' },
          { label: 'front_basis',       value: '+1.20 (M5−Q5)' },
          { label: 'oi_ratio',          value: '0.62' },
          { label: 'mom_5d',            value: '+85 ticks' },
          { label: 'seasonality_score', value: '+0.12' },
          { label: 'cot_net',           value: '+0.78 (top decile)' },
        ],
        math: [
          { label: '10y real yield Δ5d',    value: '+12 bps' },
          { label: 'GC vs real-yield z',    value: '+1.94σ' },
          { label: 'entry',                 value: 'short 1 GCM5 at 2342.0' },
          { label: 'stop',                  value: '2348.0 (60 ticks)' },
          { label: 'target',                value: '2326.0 (160 ticks)' },
          { label: 'risk: 1 × $10 × 60',    value: '$600' },
          { label: 'reward: 1 × $10 × 160', value: '$1,600' },
          { label: 'R',                     value: '2.67' },
        ],
        decision: 'Short 1 GCM5 at 2342.0, stop 2348.0, work to 2326.0.',
        close:    'Settled 2328.5.',
        clv:      'CLV +135 ticks vs entry.',
        outcome:  'Illustration: covered 2326.0 for $1,600. The COT crowd was already long; the divergence resolved through them. Illustration · not a track record.',
      },
    },
    sub: {
      name: 'Asia-session liquidity flush',
      market: 'front-month outright',
      threshold: 'oi_ratio > 0.6 with negative mom_5d into Tokyo open',
      when:  'When front-month OI is crowded and price gaps down into Asia without a fundamental driver, fade the gap.',
      why:   'Positioning unwinds first, fundamentals second. Asia gaps fill 70%+ of the time within session when London hands the book back at the bell.',
      example: {
        game: 'GCQ5 — August Gold',
        market: 'front-month outright',
        signal: [
          { label: 'contract',          value: 'GCQ5' },
          { label: 'tick_value',        value: '$10.00' },
          { label: 'front_basis',       value: '+1.80 (Q5−Z5)' },
          { label: 'oi_ratio',          value: '0.64' },
          { label: 'mom_5d',            value: '−45 ticks' },
          { label: 'seasonality_score', value: '−0.22' },
          { label: 'cot_net',           value: '+0.72' },
        ],
        math: [
          { label: 'Asia gap',             value: '−80 ticks' },
          { label: '20-session fill rate', value: '71%' },
          { label: 'entry',                value: 'long 2 GCQ5 at 2380.0' },
          { label: 'stop',                 value: '2376.0 (40 ticks)' },
          { label: 'target',               value: '2388.0 (80 ticks)' },
          { label: 'risk: 2 × $10 × 40',   value: '$800' },
          { label: 'reward: 2 × $10 × 80', value: '$1,600' },
          { label: 'R',                    value: '2.0' },
        ],
        decision: 'Long 2 GCQ5 at 2380.0, stop 2376.0, target 2388.0.',
        close:    'Settled 2387.5.',
        clv:      'CLV +75 ticks vs entry.',
        outcome:  'Illustration: scaled out at 2388.0 for $1,600. London handed it back at the bell. Illustration · not a track record.',
      },
    },
    anti: [
      'Buying gold on geopolitical headlines. The move is already priced before you have read the lede.',
      'Selling silver to hedge gold longs. Different vol regime — you are not flat, you are gross.',
      'Holding through FOMC without a defined exit. Two-way risk priced as one-way is a coin flip with juice.',
      'Trading gold and miners as the same trade. Equity beta and miner-specific dilution leak the hedge in both directions.',
    ],
  },

  ZC: {
    root: 'ZC',
    name: 'Corn',
    category: 'grains',
    tone: 'amber',
    primaryTrade: 'front-month outright',
    edgeTrigger: 'mom_5d > 1σ into WASDE with oi_ratio > 0.55',
    thesis: 'Corn prints WASDE monthly. The spec crowd front-runs the report; the mean reversion is what you trade, not the headline.',
    whereTheEdgeLives:
      'WASDE is a survey, not a discovery. The market moves into the print, prices the consensus, and reverts when the print lands inside the confidence interval — which it usually does. ' +
      'A 1σ mom_5d into the report with crowded front-month OI is a fade setup more often than it is a breakout. ' +
      'Read the basis after the print, not before; the basis is the truth the survey is trying to estimate.',
    readSignal: SIGNAL_FIELDS,
    primary: {
      name: 'WASDE-day fade',
      market: 'front-month outright',
      threshold: 'mom_5d > 1σ vs 20-session into report and oi_ratio > 0.55',
      when:  'When front-month corn rallies more than 1σ into a WASDE print and front OI is crowded, fade the move.',
      why:   'Spec longs front-run; the print rarely surprises by more than 1σ relative to the build. Reversion happens inside three sessions as the longs unwind.',
      example: {
        game: 'ZCN5 — July Corn',
        market: 'front-month outright',
        signal: [
          { label: 'contract',          value: 'ZCN5' },
          { label: 'tick_value',        value: '$12.50' },
          { label: 'front_basis',       value: '−2.50¢ (N5−U5)' },
          { label: 'oi_ratio',          value: '0.59' },
          { label: 'mom_5d',            value: '+72 ticks (+18¢)' },
          { label: 'seasonality_score', value: '+0.45' },
          { label: 'cot_net',           value: '+0.66' },
        ],
        math: [
          { label: 'z vs 20-session',         value: '+1.42σ' },
          { label: 'entry',                   value: "short 2 ZCN5 at 462'4" },
          { label: 'stop',                    value: "466'0 (14 ticks)" },
          { label: 'target',                  value: "454'0 (34 ticks)" },
          { label: 'risk: 2 × $12.50 × 14',   value: '$350' },
          { label: 'reward: 2 × $12.50 × 34', value: '$850' },
          { label: 'R',                       value: '2.43' },
        ],
        decision: "Short 2 ZCN5 at 462'4, stop 466'0, work to 454'0.",
        close:    "Settled 455'2.",
        clv:      'CLV +30 ticks vs entry.',
        outcome:  "Illustration: covered 454'0 for $850. WASDE printed neutral on yield; bullish positioning unwound inside three sessions. Illustration · not a track record.",
      },
    },
    sub: {
      name: 'South-American weather risk premium',
      market: 'front-month outright',
      threshold: 'seasonality_score > +0.5 with negative mom_5d in Jan–Feb',
      when:  'In Jan–Feb when South-American weather risk premium gets washed out by funds, buy the dip.',
      why:   'SA crop tail risk dwarfs spec positioning. The curve gives back the premium when stress headlines hit — and one or two headlines is the typical re-pricing event.',
      example: {
        game: 'ZCH5 — March Corn',
        market: 'front-month outright',
        signal: [
          { label: 'contract',          value: 'ZCH5' },
          { label: 'tick_value',        value: '$12.50' },
          { label: 'front_basis',       value: '−1.25¢' },
          { label: 'oi_ratio',          value: '0.51' },
          { label: 'mom_5d',            value: '−48 ticks (−12¢)' },
          { label: 'seasonality_score', value: '+0.58' },
          { label: 'cot_net',           value: '−0.34' },
        ],
        math: [
          { label: 'Argentina drought monitor', value: '+30% short-term anomaly' },
          { label: 'entry',                     value: "long 1 ZCH5 at 432'0" },
          { label: 'stop',                      value: "428'0 (16 ticks)" },
          { label: 'target',                    value: "440'0 (32 ticks)" },
          { label: 'risk: 1 × $12.50 × 16',     value: '$200' },
          { label: 'reward: 1 × $12.50 × 32',   value: '$400' },
          { label: 'R',                         value: '2.0' },
        ],
        decision: "Long 1 ZCH5 at 432'0, stop 428'0, work to 440'0.",
        close:    "Settled 439'6.",
        clv:      'CLV +30 ticks vs entry.',
        outcome:  "Illustration: scaled out at 440'0 for $400. Two Argentina headlines did the work inside three sessions. Illustration · not a track record.",
      },
    },
    anti: [
      'Trading the WASDE first 60 seconds. Fills are decorative; the algos eat the print.',
      'Crossing into inter-month spreads without the margin tab open. Grain spreads margin like outrights and they will gap.',
      'Reading USDA reports as policy. They are surveys with confidence intervals — treat them as such.',
      'Buying corn on a single-state crop tour. The tour is a slice; the basis is the truth.',
    ],
  },

  KC: {
    root: 'KC',
    name: 'Coffee C',
    category: 'softs',
    tone: 'red',
    primaryTrade: 'front-month outright',
    edgeTrigger: 'mom_5d > 2σ in Jun–Aug with seasonality_score > +0.3',
    thesis: 'Coffee prices Brazilian weather risk in real time and overshoots on every frost headline. The damage estimate is the trade, not the headline.',
    whereTheEdgeLives:
      'Arabica is a weather option masquerading as a commodity. Funds bid the front when frost or drought lands the front page; certified-stocks numbers and confirmed damage estimates land 48–96 hours later. ' +
      'A 2σ rip in Jun–Aug without a ≥5%-of-crop damage estimate is a sentiment trade, and sentiment trades unwind on the second print. ' +
      'Read cot_net before sizing the fade — top-decile longs are the unwind fuel you are betting on.',
    readSignal: SIGNAL_FIELDS,
    primary: {
      name: 'Brazilian frost premium fade',
      market: 'front-month outright',
      threshold: 'mom_5d > 2σ in Jun–Aug with seasonality_score > +0.3 and cot_net top quartile',
      when:  'When KC rallies more than 2σ on Brazil frost or drought headlines without a confirmed ≥5%-of-crop damage estimate, fade.',
      why:   'Frost premium is sentiment-driven. Spec longs unwind once damage estimates land inside historical range, which is the modal outcome. The unwind is the trade.',
      example: {
        game: 'KCU5 — September Coffee',
        market: 'front-month outright',
        signal: [
          { label: 'contract',          value: 'KCU5' },
          { label: 'tick_value',        value: '$18.75' },
          { label: 'front_basis',       value: '+3.50¢ (U5−Z5)' },
          { label: 'oi_ratio',          value: '0.61' },
          { label: 'mom_5d',            value: '+850 ticks' },
          { label: 'seasonality_score', value: '+0.52' },
          { label: 'cot_net',           value: '+0.84 (top decile)' },
        ],
        math: [
          { label: 'z vs 20-session',          value: '+2.31σ' },
          { label: 'frost damage estimate',    value: 'under 4% of crop' },
          { label: 'entry',                    value: 'short 1 KCU5 at 244.50' },
          { label: 'stop',                     value: '248.00 (70 ticks)' },
          { label: 'target',                   value: '232.00 (250 ticks)' },
          { label: 'risk: 1 × $18.75 × 70',    value: '$1,312.50' },
          { label: 'reward: 1 × $18.75 × 250', value: '$4,687.50' },
          { label: 'R',                        value: '3.57' },
        ],
        decision: 'Short 1 KCU5 at 244.50, stop 248.00, work to 232.00.',
        close:    'Settled 233.10.',
        clv:      'CLV +228 ticks vs entry.',
        outcome:  'Illustration: covered 232.00 for $4,687.50. Damage estimates landed inside historical range; spec longs flushed across two sessions. Illustration · not a track record.',
      },
    },
    sub: {
      name: 'Vietnamese harvest unwind',
      market: 'front-month outright',
      threshold: 'seasonality_score < −0.4 in Nov–Jan with cot_net > +0.7',
      when:  'When Vietnamese robusta harvest pressures the curve and arabica longs are still crowded, sell the rich leg.',
      why:   'Arabica-robusta arbitrage tightens at robusta harvest. Crowded arabica longs exit on small triggers when the spread compresses; you do not need to leg the cross-exchange spread to collect that.',
      example: {
        game: 'KCH5 — March Coffee',
        market: 'front-month outright',
        signal: [
          { label: 'contract',          value: 'KCH5' },
          { label: 'tick_value',        value: '$18.75' },
          { label: 'front_basis',       value: '+1.20¢' },
          { label: 'oi_ratio',          value: '0.55' },
          { label: 'mom_5d',            value: '+180 ticks' },
          { label: 'seasonality_score', value: '−0.48' },
          { label: 'cot_net',           value: '+0.76' },
        ],
        math: [
          { label: 'arabica-robusta z',        value: '−1.62σ (rich arabica)' },
          { label: 'entry',                    value: 'short 1 KCH5 at 218.40' },
          { label: 'stop',                     value: '220.00 (32 ticks)' },
          { label: 'target',                   value: '213.00 (108 ticks)' },
          { label: 'risk: 1 × $18.75 × 32',    value: '$600.00' },
          { label: 'reward: 1 × $18.75 × 108', value: '$2,025.00' },
          { label: 'R',                        value: '3.38' },
        ],
        decision: 'Short 1 KCH5 at 218.40, stop 220.00, work to 213.00.',
        close:    'Settled 213.45.',
        clv:      'CLV +99 ticks vs entry.',
        outcome:  'Illustration: covered 213.00 for $2,025. Robusta harvest priced in within four sessions. Illustration · not a track record.',
      },
    },
    anti: [
      'Buying coffee on a single weather model. Models drift; the basis does not.',
      'Selling KC short into a confirmed frost without a stop above the prior swing. Limit-up days are real.',
      'Adding length on the certified-stocks number alone. It is a backwards-looking inventory print.',
      'Trading the open-outcry close as the settle. Electronic settle is the one that pays.',
    ],
  },

  LE: {
    root: 'LE',
    name: 'Live Cattle',
    category: 'livestock',
    tone: 'red',
    primaryTrade: 'front-month outright',
    edgeTrigger: 'mom_5d > 1.2σ into Cattle-on-Feed with oi_ratio > 0.55',
    thesis: 'Live cattle prints Cattle-on-Feed monthly. Spec positioning front-runs; the report is rarely a 1σ surprise relative to the build. The mean reversion is the trade.',
    whereTheEdgeLives:
      'Cattle is a slow market with two prints that matter: monthly Cattle-on-Feed and weekly boxed-beef cutout. Funds rip the front month into the COF print and unwind on the Friday-after settle, regardless of the headline. ' +
      'The basis to cash converges on physical pricing inside the contract month, so the futures overshoot has a hard ceiling — the cash auction. ' +
      'Read cutout against the 20-day mean before sizing — rich cutout is the unwind fuel.',
    readSignal: SIGNAL_FIELDS,
    primary: {
      name: 'Cattle-on-Feed fade',
      market: 'front-month outright',
      threshold: 'mom_5d > 1.2σ into Cattle-on-Feed report with oi_ratio > 0.55',
      when:  'When LE rallies more than 1.2σ into the monthly Cattle-on-Feed print, fade.',
      why:   'Spec positioning front-runs the print. The report is rarely a 1σ surprise relative to the build, and the unwind happens on the Friday-after settle as funds reset.',
      example: {
        game: 'LEM5 — June Live Cattle',
        market: 'front-month outright',
        signal: [
          { label: 'contract',          value: 'LEM5' },
          { label: 'tick_value',        value: '$10.00' },
          { label: 'front_basis',       value: '+1.20¢ (M5−Q5)' },
          { label: 'oi_ratio',          value: '0.58' },
          { label: 'mom_5d',            value: '+180 ticks' },
          { label: 'seasonality_score', value: '−0.18' },
          { label: 'cot_net',           value: '+0.71' },
        ],
        math: [
          { label: 'z vs 20-session',         value: '+1.45σ' },
          { label: 'entry',                   value: 'short 2 LEM5 at 184.40' },
          { label: 'stop',                    value: '185.40 (40 ticks)' },
          { label: 'target',                  value: '182.00 (96 ticks)' },
          { label: 'risk: 2 × $10 × 40',      value: '$800' },
          { label: 'reward: 2 × $10 × 96',    value: '$1,920' },
          { label: 'R',                       value: '2.4' },
        ],
        decision: 'Short 2 LEM5 at 184.40, stop 185.40, work to 182.00.',
        close:    'Settled 182.05.',
        clv:      'CLV +94 ticks vs entry.',
        outcome:  'Illustration: scaled out at 182.00 for $1,920. Report printed in line; spec longs unwound on Friday. Illustration · not a track record.',
      },
    },
    sub: {
      name: 'Boxed-beef cutout reversion',
      market: 'front-month outright',
      threshold: 'cutout > +1.5σ vs 20-day mean with cot_net > +0.6',
      when:  'When boxed-beef cutout pulls LE futures more than 1.5σ rich, fade as the cutout reverts.',
      why:   'Cash-futures basis converges on physical pricing. Cutout overshoots into grilling season and gives back through Mon–Wed prints; the futures follow.',
      example: {
        game: 'LEQ5 — August Live Cattle',
        market: 'front-month outright',
        signal: [
          { label: 'contract',          value: 'LEQ5' },
          { label: 'tick_value',        value: '$10.00' },
          { label: 'front_basis',       value: '+0.60¢' },
          { label: 'oi_ratio',          value: '0.56' },
          { label: 'mom_5d',            value: '+120 ticks' },
          { label: 'seasonality_score', value: '+0.31' },
          { label: 'cot_net',           value: '+0.65' },
        ],
        math: [
          { label: 'cutout z vs 20-day',   value: '+1.78σ' },
          { label: 'entry',                value: 'short 1 LEQ5 at 188.20' },
          { label: 'stop',                 value: '189.10 (36 ticks)' },
          { label: 'target',               value: '186.00 (88 ticks)' },
          { label: 'risk: 1 × $10 × 36',   value: '$360' },
          { label: 'reward: 1 × $10 × 88', value: '$880' },
          { label: 'R',                    value: '2.44' },
        ],
        decision: 'Short 1 LEQ5 at 188.20, stop 189.10, work to 186.00.',
        close:    'Settled 186.05.',
        clv:      'CLV +85 ticks vs entry.',
        outcome:  'Illustration: covered 186.00 for $880. Cutout printed lower Mon–Wed; spec longs took the loss into Friday. Illustration · not a track record.',
      },
    },
    anti: [
      'Trading the Cattle-on-Feed print inside the first minute. Daily limits trigger; you do not get filled, you get printed at.',
      'Crossing into feeders to "hedge" cattle longs. Different feed-margin geometry — you have doubled, not hedged.',
      'Buying limit-up days on momentum. The limit is the noise floor, not a breakout.',
      'Reading USDA monthly numbers as a trade. They are a reference; the basis is the trade.',
    ],
  },
}

export const CATEGORY_META: Record<Category, { label: string; blurb: string; tone: Tone; headline: string }> = {
  energy:    { label: 'Energy',    blurb: 'WTI, gas, distillates. Inventory cycles and term-structure flips are the trade.',                tone: 'orange', headline: 'CL' },
  metals:    { label: 'Metals',    blurb: 'Gold, silver, copper. Real yields and positioning. Geopolitics is already in the price.',         tone: 'amber',  headline: 'GC' },
  grains:    { label: 'Grains',    blurb: 'Corn, wheat, beans. WASDE prints and weather. The basis is the truth, not the survey.',           tone: 'amber',  headline: 'ZC' },
  softs:     { label: 'Softs',     blurb: 'Coffee, cocoa, cotton. Brazil weather, certified stocks, harvest pressure.',                      tone: 'red',    headline: 'KC' },
  livestock: { label: 'Livestock', blurb: 'Cattle and hogs. Cattle-on-Feed positioning vs cash-cutout reversion.',                           tone: 'red',    headline: 'LE' },
}

export function tickPnL(spec: Contract, ticks: number): number {
  return spec.tickValue * ticks
}

export function contractValue(spec: Contract, price: number): number {
  return spec.contractSize * price
}

export function rollCost(spec: Contract, frontMinusBack: number): number {
  return (frontMinusBack / spec.tickSize) * spec.tickValue
}

export function COMMODITY_HREF(root: string): string {
  return `/commodities/${root.toLowerCase()}`
}
