// Source-adapter contracts. The beta only wires the Retail feed (The
// Racing API). Sharp / Prediction are stubbed; once credentials land we
// replace the stub with a real adapter without touching the aggregator.
//
//   Sharp      → sharp market makers (e.g. Pinnacle, Betfair Exchange)
//   Retail     → retail books / data aggregators (The Racing API today)
//   Prediction → prediction markets (e.g. Polymarket, ProphetX)

export interface SourceQuote {
  // Decimal odds the source is offering / implying for the named runner.
  odds_decimal: number | null
  // Optional implied probability override (0-1). When null we derive it
  // from odds_decimal. Useful for prediction markets that quote
  // probability directly.
  implied_prob?: number | null
}

export interface SourceQuotes {
  source: string
  // horse_id → quote
  quotes: Record<string, SourceQuote>
}

export interface HorseRacingSource {
  name: string
  kind: 'sharp' | 'retail' | 'prediction'
  isConfigured(): boolean
  // Returns null when not configured / no data available for the race.
  fetchQuotes(raceId: string): Promise<SourceQuotes | null>
}
