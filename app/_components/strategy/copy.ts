// Per-sport playbook copy. Single source of truth — every strategy panel
// on /sports/[league] reads from this file. Voice mirrors Ceelo's article
// prompt: dry, sharp, numbers-first, no exclamation points.

export type Sport = 'NFL' | 'NBA' | 'NHL' | 'MLB'
export type Tone = 'amber' | 'orange' | 'red'

export interface WorkedExample {
  game: string
  market: string
  signal: { label: string; value: string }[]   // Ceelo's posted fields
  math:   { label: string; value: string }[]   // viewer-side math
  decision: string                             // what to do with it
  close:  string                               // close-line outcome
  clv:    string                               // CLV note
  outcome: string                              // graded result
}

export interface Strategy {
  name: string
  market: string
  threshold: string
  when: string
  why: string
  example: WorkedExample
}

export interface SportPlaybook {
  sport: Sport
  tone: Tone
  primaryMarket: string
  edgeThreshold: string
  thesis: string
  whereTheEdgeLives: string
  readSignal: { field: string; meaning: string }[]
  primary: Strategy
  sub: Strategy
  anti: string[]
}

const SIGNAL_FIELDS: { field: string; meaning: string }[] = [
  { field: 'model_prob',   meaning: 'Ceelo’s win probability for the named side. Compare to no-vig implied at min_odds.' },
  { field: 'model_spread', meaning: 'Where Ceelo lands the line. The number you’d offer if you were the book.' },
  { field: 'book_spread',  meaning: 'What the market is laying right now. Your reference point.' },
  { field: 'edge_points',  meaning: 'model_spread minus book_spread, in points. The gap you’re paid to take.' },
  { field: 'edge_pct',     meaning: 'No-vig edge in percent. Feeds Kelly directly.' },
  { field: 'min_odds',     meaning: 'Worst price Ceelo will accept. Below this, the math breaks.' },
  { field: 'confidence',   meaning: 'low | medium | high. Scales stake, not whether you bet.' },
]

export const PLAYBOOK: Record<Sport, SportPlaybook> = {
  NFL: {
    sport: 'NFL',
    tone: 'red',
    primaryMarket: 'spread',
    edgeThreshold: 'edge_points ≥ 1.5',
    thesis: 'NFL margins cluster on 3 and 7. A point of edge across a key number is worth multiples of the same point off it.',
    whereTheEdgeLives:
      'Half of NFL games land within a touchdown. Three is the densest single margin in the sport, seven is second. ' +
      'A spread that moves you from −3.5 to −2.5 is a different bet than one that moves you from −5.5 to −4.5 — ' +
      'the first crosses a key number, the second doesn’t. Ceelo’s edge_points are not all worth the same.',
    readSignal: SIGNAL_FIELDS,
    primary: {
      name: 'Spread, key-number aware',
      market: 'spread',
      threshold: 'edge_points ≥ 1.5 and confidence ≥ medium',
      when:  'When Ceelo’s model_spread crosses 3 or 7 vs book_spread, double-weight it. When it doesn’t, the same edge is worth less.',
      why:   'The empirical margin distribution is spiked at 3 and 7. Crossing those numbers converts pushes into wins and losses into pushes.',
      example: {
        game: 'KC @ BUF',
        market: 'spread',
        signal: [
          { label: 'side',         value: 'BUF −2.5' },
          { label: 'model_spread', value: '−4.1' },
          { label: 'book_spread',  value: '−2.5' },
          { label: 'edge_points',  value: '+1.6' },
          { label: 'edge_pct',     value: '+5.2%' },
          { label: 'min_odds',     value: '−110' },
          { label: 'confidence',   value: 'medium' },
        ],
        math: [
          { label: 'no-vig implied @ −110', value: '50.0%' },
          { label: 'model_prob',                 value: '55.2%' },
          { label: 'edge over no-vig',           value: '+5.2%' },
          { label: 'crosses key number',         value: 'no (2.5 → 4.1, no 3)' },
          { label: '¼-Kelly stake',         value: '1.3u' },
        ],
        decision: 'Take BUF −2.5 at −110 for 1.3u. Pass anything worse than −115.',
        close: 'Closed BUF −3 −110.',
        clv:   'CLV +0.5 pts — you bought the 3 before the market did.',
        outcome: 'Illustration: BUF wins by 6, ticket cashes. CLV is the score that matters across a season; one ticket is noise.',
      },
    },
    sub: {
      name: '1H spread, game-script skew',
      market: '1H spread',
      threshold: '|model_spread − book_spread| ≥ 1.0 with reasoning citing pace or script',
      when:  'When Ceelo’s reasoning flags one team as script-favored (early lead expected), the 1H spread captures it cleaner than the full game.',
      why:   'Full-game spreads bake in late-game garbage time and backdoors. 1H markets isolate the script Ceelo is actually modeling.',
      example: {
        game: 'PHI @ DAL',
        market: '1H spread',
        signal: [
          { label: 'side',         value: 'PHI −1.5 (1H)' },
          { label: 'model_spread', value: '−2.8 (full)' },
          { label: 'book_spread',  value: '−1.5 (full)' },
          { label: 'edge_points',  value: '+1.3' },
          { label: 'min_odds',     value: '−110' },
          { label: 'confidence',   value: 'high' },
          { label: 'reasoning',    value: 'PHI starts hot at home; DAL slow first quarters' },
        ],
        math: [
          { label: '1H derivative (rule of thumb)', value: 'PHI −1.5 → PHI 1H −1.5 should price near pk' },
          { label: 'book offering 1H',              value: 'PHI 1H −1 −110' },
          { label: 'derived edge (1H)',             value: '+0.5 to +0.8 pts' },
          { label: '¼-Kelly stake',            value: '1.0u' },
        ],
        decision: 'Take PHI 1H −1 −110 for 1.0u. Skip the full-game side — you’re paying for late variance you don’t need.',
        close: 'Closed PHI 1H −1.5 −105.',
        clv:   'CLV +0.5 pts on the half.',
        outcome: 'Illustration: PHI leads 17–7 at half, ticket cashes. The full game closed PHI by 1 — the 1H caught the script, the full game didn’t.',
      },
    },
    anti: [
      'Parlaying NFL sides. Two −110s pay 2.6 instead of 3.0 — you give the book 13% to staple bets together.',
      'Betting low confidence at full ¼-Kelly. Scale to ⅛-Kelly or pass.',
      'Chasing line moves after Sunday morning injury news. The market already priced it.',
      'Ignoring CLV. You can’t grade your skill on a 16-game sample of W/L — closing-line value is the only thing that converges.',
    ],
  },

  NBA: {
    sport: 'NBA',
    tone: 'orange',
    primaryMarket: 'total',
    edgeThreshold: 'edge_pct ≥ 4%',
    thesis: 'NBA totals price pace × efficiency. The market is sharp on sides, softer on totals — that’s where Ceelo’s model_prob beats book.',
    whereTheEdgeLives:
      'Sides in the NBA see heavy line-shopping; book disagreements are tight. Totals carry more model risk for the books — ' +
      'pace estimates drift, role players come back from minutes restrictions, and team total subdivisions stay even softer. ' +
      'Read Ceelo’s model_prob against no-vig implied at min_odds before reading the spread.',
    readSignal: SIGNAL_FIELDS,
    primary: {
      name: 'Total, no-vig anchored',
      market: 'total',
      threshold: 'edge_pct ≥ 4% and confidence ≥ medium',
      when:  'When model_prob clears the no-vig implied at min_odds by 4+ percentage points. Totals only — sides are too efficient.',
      why:   'A 4% no-vig edge at −110 is a real fractional-Kelly bet. Below 4%, juice eats most of the theoretical EV.',
      example: {
        game: 'BOS @ DEN',
        market: 'total',
        signal: [
          { label: 'side',         value: 'Over 228.5' },
          { label: 'model_prob',   value: '0.566' },
          { label: 'book_total',   value: '228.5' },
          { label: 'min_odds',     value: '−110' },
          { label: 'confidence',   value: 'medium' },
          { label: 'reasoning',    value: 'BOS pace up vs zone, DEN no rest disadvantage' },
        ],
        math: [
          { label: 'implied @ −110',     value: '52.4%' },
          { label: 'no-vig implied',          value: '50.0%' },
          { label: 'model_prob',              value: '56.6%' },
          { label: 'edge_pct over no-vig',    value: '+6.6%' },
          { label: '¼-Kelly stake',      value: '1.6u' },
        ],
        decision: 'Take Over 228.5 at −110 for 1.6u. Below −115 the edge is gone.',
        close: 'Closed Over 230 −110.',
        clv:   'CLV +1.5 pts on the total.',
        outcome: 'Illustration: 232 final, ticket cashes. Even on a loss the +1.5 CLV is what you log.',
      },
    },
    sub: {
      name: 'Team total, pace-mismatch flag',
      market: 'team total',
      threshold: 'reasoning cites pace mismatch or rotation news',
      when:  'When Ceelo’s reasoning cites a one-sided pace mismatch, take the team total over the side. Books split team totals at lower limits and slower lines.',
      why:   'Sides force you to predict who wins. Team totals only require one team to score what Ceelo modeled — half the variance.',
      example: {
        game: 'SAC @ MEM',
        market: 'team total',
        signal: [
          { label: 'side',         value: 'SAC team total Over 119.5' },
          { label: 'model_prob',   value: '0.58' },
          { label: 'min_odds',     value: '−115' },
          { label: 'confidence',   value: 'medium' },
          { label: 'reasoning',    value: 'MEM bottom-five pace defense, SAC top-three pace offense' },
        ],
        math: [
          { label: 'no-vig implied @ −115', value: '52.3%' },
          { label: 'model_prob',                 value: '58.0%' },
          { label: 'edge_pct',                   value: '+5.7%' },
          { label: '¼-Kelly stake',         value: '1.4u' },
        ],
        decision: 'Take SAC team total Over 119.5 −115 for 1.4u. Don’t cross to the side — you’re paying for the wrong variance.',
        close: 'Closed SAC team total Over 121 −110.',
        clv:   'CLV +1.5 pts plus 5c of price.',
        outcome: 'Illustration: SAC scores 124, ticket cashes regardless of game outcome.',
      },
    },
    anti: [
      'Betting first-quarter sides. Variance is too high vs the edge size.',
      'Chasing player props off the same model. Ceelo posts team-level signal — props are downstream noise.',
      'Stacking unders across slates. Pace correlates; correlated unders are not independent.',
      'Buying the hook on totals. The juice you pay almost never matches the half-point of equity.',
    ],
  },

  NHL: {
    sport: 'NHL',
    tone: 'amber',
    primaryMarket: 'puck line',
    edgeThreshold: 'model_prob ≥ 0.45 on +1.5',
    thesis: 'NHL is low-scoring and goalie-driven. Puck line +1.5 turns short-priced dogs into favorite-priced bets at a fraction of the variance.',
    whereTheEdgeLives:
      'A typical NHL final is decided by 1–2 goals. That makes moneyline dogs lose 55%+ of the time on the scoreboard but ' +
      'cover the +1.5 puck line 70%+ of the time. The market prices the empty-net swing into the puck line, but it under-prices ' +
      'how often Ceelo’s model_prob lands a dog inside one goal.',
    readSignal: SIGNAL_FIELDS,
    primary: {
      name: 'Puck line +1.5 dog',
      market: 'puck line',
      threshold: 'model_prob ≥ 0.45 and book ML ≥ +130',
      when:  'When Ceelo’s model_prob on the dog is ≥ 0.45, the +1.5 puck line is almost always the +EV side over the moneyline.',
      why:   'Empty-net goals add ~7% to the favorite’s 2-goal-margin frequency. That tax is already in the puck-line price; Ceelo’s 0.45 ML probability translates to ~0.65–0.70 puck-line probability.',
      example: {
        game: 'COL @ DAL',
        market: 'puck line',
        signal: [
          { label: 'side',         value: 'COL +1.5' },
          { label: 'model_prob',   value: '0.47 (ML)' },
          { label: 'book ML',      value: '+145' },
          { label: 'book PL',      value: '−165' },
          { label: 'confidence',   value: 'medium' },
          { label: 'reasoning',    value: 'COL backup goalie, DAL top line gets matched away' },
        ],
        math: [
          { label: 'ML → PL conversion',     value: '0.47 ML → ≈0.68 PL' },
          { label: 'no-vig implied @ −165',  value: '62.3%' },
          { label: 'model PL prob',               value: '68.0%' },
          { label: 'edge_pct',                    value: '+5.7%' },
          { label: '¼-Kelly stake',          value: '1.4u' },
        ],
        decision: 'Take COL +1.5 at −165 for 1.4u. Pass the ML — same view, worse variance.',
        close: 'Closed COL +1.5 −175.',
        clv:   'CLV +10c of price.',
        outcome: 'Illustration: DAL wins 4–3, ticket cashes on the cover. ML would have lost — same read, different variance, different outcome.',
      },
    },
    sub: {
      name: '1st-period under, model-spread skew',
      market: '1st period total',
      threshold: 'model_spread − book_spread ≤ −0.4',
      when:  'When Ceelo lands the full-game total below market by 0.4+ goals, the 1st-period under is usually pricing as if the game runs at market’s pace.',
      why:   'First-period totals derive from full-game totals at roughly 0.32×. A 0.4-goal disagreement at the full-game level is a 0.13-goal disagreement at the 1P level — small in absolute terms, but the 1P number only moves in 0.5 increments.',
      example: {
        game: 'BOS @ TOR',
        market: '1st period total',
        signal: [
          { label: 'side',          value: 'Under 1.5 (1P)' },
          { label: 'model_total',   value: '5.6 (full)' },
          { label: 'book_total',    value: '6.0 (full)' },
          { label: 'edge (full)',   value: '−0.4 goals' },
          { label: 'min_odds',      value: '+105' },
          { label: 'confidence',    value: 'medium' },
        ],
        math: [
          { label: '1P derivative',         value: '~0.32× full-game total → 1.79 model vs 1.92 book' },
          { label: 'book line',             value: 'Under 1.5 +105' },
          { label: 'no-vig implied @ +105', value: '48.8%' },
          { label: 'model 1P under prob',   value: '≈54%' },
          { label: '¼-Kelly stake',    value: '0.8u' },
        ],
        decision: 'Take Under 1.5 (1P) +105 for 0.8u. Smaller stake — 1P markets are noisier and limits are lower.',
        close: 'Closed Under 1.5 (1P) −105.',
        clv:   'CLV +10c.',
        outcome: 'Illustration: 1–1 after 20 minutes, ticket cashes. The full game went to OT — the 1P read was independent.',
      },
    },
    anti: [
      'Betting ML dogs at +200 or worse on Ceelo’s read. The variance is wrong; take the puck line.',
      'Three-way regulation lines unless you’ve done the OT math yourself. Ceelo posts 60-minute moneyline equivalents.',
      'Goalie-pull-driven live bets. The shape of the curve is steep; you’ll get filled on the wrong side.',
      'Stacking puck-line dogs as a parlay. The book’s correlation pricing is sharper than you.',
    ],
  },

  MLB: {
    sport: 'MLB',
    tone: 'orange',
    primaryMarket: 'F5 (first 5 innings)',
    edgeThreshold: 'edge_pct ≥ 3% on F5',
    thesis: 'In MLB the starting pitcher is the signal and the bullpen is noise. F5 markets let you bet the signal you actually have.',
    whereTheEdgeLives:
      'A full-game MLB bet is one starting-pitcher prediction and two bullpen predictions. Ceelo’s model gets the starter ' +
      'right; his bullpen modeling is no better than the market’s. The F5 market closes the bet at the inning the signal ends. ' +
      'Same edge, less variance.',
    readSignal: SIGNAL_FIELDS,
    primary: {
      name: 'F5 side, starter-driven',
      market: 'F5 moneyline',
      threshold: 'edge_pct ≥ 3% and reasoning cites starter matchup',
      when:  'When Ceelo’s reasoning is dominated by a starter quality gap, take the F5 moneyline instead of the full-game.',
      why:   'F5 moneylines settle after the starters’ best 5 innings. You stop paying for bullpen variance you have no edge in.',
      example: {
        game: 'NYY @ HOU',
        market: 'F5 moneyline',
        signal: [
          { label: 'side',         value: 'NYY F5 ML' },
          { label: 'model_prob',   value: '0.555' },
          { label: 'book F5 ML',   value: '−115' },
          { label: 'min_odds',     value: '−120' },
          { label: 'confidence',   value: 'high' },
          { label: 'reasoning',    value: 'Cole vs swing-heavy lineup; HOU SP whiff rate bottom-quartile' },
        ],
        math: [
          { label: 'no-vig implied @ −115', value: '52.3%' },
          { label: 'model_prob',                 value: '55.5%' },
          { label: 'edge_pct',                   value: '+3.2%' },
          { label: '¼-Kelly stake',         value: '0.8u' },
        ],
        decision: 'Take NYY F5 ML −115 for 0.8u. Skip the full-game ML — you don’t have a bullpen read.',
        close: 'Closed NYY F5 ML −125.',
        clv:   'CLV +10c.',
        outcome: 'Illustration: NYY leads 3–1 after 5, ticket cashes. HOU bullpen ties it in the 7th — full-game ML would have lost. Signal vs noise.',
      },
    },
    sub: {
      name: 'F5 RL +0.5 instead of heavy chalk',
      market: 'F5 run line',
      threshold: 'full-game ML chalk ≤ −180',
      when:  'When Ceelo lands a side but the full-game moneyline is heavy chalk, take F5 RL +0.5 on that same side.',
      why:   '−180+ chalk pays you 56 cents on the dollar. F5 RL +0.5 prices the same side at near pk — same read, better price, less variance.',
      example: {
        game: 'LAD @ COL',
        market: 'F5 RL +0.5',
        signal: [
          { label: 'side',         value: 'LAD F5 RL +0.5' },
          { label: 'model_prob',   value: '0.61 (ML)' },
          { label: 'book full ML', value: '−210' },
          { label: 'book F5 RL',   value: '−105' },
          { label: 'confidence',   value: 'high' },
        ],
        math: [
          { label: 'F5 RL +0.5 ≈ ML',    value: 'tied or ahead after 5' },
          { label: 'no-vig implied @ −105', value: '50.0%' },
          { label: 'model F5 RL prob',           value: '≈60%' },
          { label: 'edge_pct',                   value: '+10%' },
          { label: '¼-Kelly stake',         value: '2.5u' },
        ],
        decision: 'Take LAD F5 RL +0.5 −105 for 2.5u. The full-game ML pays half as much for the same read.',
        close: 'Closed LAD F5 RL +0.5 −120.',
        clv:   'CLV +15c.',
        outcome: 'Illustration: LAD up 4–2 after 5, ticket cashes. Full game ended 8–7 — same outcome, three units of price you didn’t need to give back.',
      },
    },
    anti: [
      'Betting heavy full-game chalk. −220 means you risk 220 to win 100. The same read on F5 pays double.',
      'YRFI / NRFI without an explicit half-inning model. Ceelo doesn’t post one.',
      'First-pitch totals before lineups. The CLV signal is in the line move post-lineup.',
      'Parlaying F5 sides. The same correlation argument as NFL — the book wins the staple.',
    ],
  },
}

export const SPORT_HREF: Record<Sport, string> = {
  NFL: '/sports/nfl',
  NBA: '/sports/nba',
  NHL: '/sports/nhl',
  MLB: '/sports/mlb',
}
