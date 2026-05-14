// Shared types for the horse-racing module. Mirrors The Racing API shape
// loosely (https://api.theracingapi.com/v1) but trimmed to the fields the
// UI + yield engine actually consume. Keep this lean — adding fields is
// cheap, but exposing the full upstream payload couples us to their schema.

export interface Runner {
  horse_id: string
  horse: string
  // Program number as the upstream prints it: "1", "1A", "1B", "2". Stored
  // verbatim so coupled NA entries ("1" vs "1A") stay distinguishable on
  // display. The yield engine never math-coerces this; it's purely a label.
  number: string | null
  draw: number | null
  jockey: string | null
  trainer: string | null
  age: number | null
  weight_lbs: number | null
  form: string | null
  // Decimal odds (e.g. 4.5 = 7/2). Null when the book hasn't posted yet.
  odds_decimal: number | null
}

export interface Race {
  race_id: string
  course: string
  // ISO country code for NA meets ('USA' | 'CAN'). Null on UK racecards
  // (which the region router still reaches in fallback mode).
  country?: string | null
  off_time: string         // 'HH:MM' local to course
  off_dt: string           // ISO timestamp (UTC) of scheduled off
  race_name: string
  distance: string | null
  going: string | null
  type: string | null      // NA: MSW/MCL/ALW/STK/CLM/OPT · UK: Flat/Hurdle/Chase
  field_size: number
  runners: Runner[]
}

export interface RaceResult {
  race_id: string
  finished_at: string      // ISO timestamp
  // Ordered by finishing position. position=1 is winner.
  finishers: Array<{
    horse_id: string
    horse: string
    position: number
    sp_decimal: number | null   // starting price (decimal)
  }>
}

// One snapshot of decimal odds for every runner in a race at a single
// instant. Kept in the cache as a 2-entry rolling window so the yield
// engine can derive velocity (up / down / flat).
export interface OddsSnapshot {
  race_id: string
  taken_at: number                    // ms epoch
  odds: Record<string, number | null> // horse_id → decimal odds
}

// The signal we attach to each race when rendering. The yield engine
// computes this from one or more sources (currently only the Racing API
// retail feed; sharp + prediction sources land later).
export interface RaceSignal {
  // The runner with the strongest derived yield. Null if we couldn't
  // compute anything (no odds, single runner, etc.).
  top_runner: {
    horse_id: string
    horse: string
    number: string | null
    odds_decimal: number | null
    fair_decimal: number | null
    edge_pct: number | null
  } | null
  // 1 (cold) .. 10 (hot). Intensity rolls confidence + edge magnitude
  // into a single bar suitable for the UI.
  intensity: number
  velocity: 'up' | 'down' | 'flat'
  // Short, deterministic, template-generated reasoning. NO LLM calls
  // happen in the yield path (mirrors Ceelo's hard rule).
  reasoning: string
}

export interface RaceWithSignal extends Race {
  signal: RaceSignal
}
