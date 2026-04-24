import OpenAI from 'openai'
import * as Alpaca from './platforms/alpaca'
import type { PoolClient } from 'pg'

const WATCHLIST = [
  'AAPL', 'MSFT', 'NVDA', 'AMD', 'TSLA',
  'AMZN', 'GOOGL', 'META', 'COIN', 'PLTR',
  'SPY', 'QQQ', 'SOFI', 'HOOD', 'MSTR',
]

const PROMPT = `You are the Vega — Lila's market intelligence officer. She is COO and you report directly to her.

Your job: surface the 1-3 best long opportunities right now based on this market data.

{MARKET_DATA}

Respond with ONLY a valid JSON array (no markdown):
[
  {
    "symbol": "TICKER",
    "direction": "long",
    "entry": 150.00,
    "target": 158.00,
    "stopLoss": 145.00,
    "confidence": 0.75,
    "riskLevel": "medium",
    "assetClass": "stock",
    "reason": "One sentence: the signal and why now."
  }
]

Rules:
- Only include if confidence >= 0.6
- stopLoss within 8% of entry
- target must give at least 2:1 reward/risk
- riskLevel: low (<3% stop), medium (3-6%), high (6-8%)
- Long only (cash account)
- Return [] if nothing qualifies today`

export interface AnalystPick {
  symbol: string
  direction: 'long'
  entry: number
  target: number
  stopLoss: number
  confidence: number
  riskLevel: 'low' | 'medium' | 'high'
  assetClass: string
  reason: string
}

export class Vega {
  private ai: OpenAI

  constructor() {
    this.ai = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY!,
      baseURL: 'https://api.deepseek.com/v1',
    })
  }

  async analyze(): Promise<AnalystPick[]> {
    const bars = await Alpaca.getBars(WATCHLIST, 25)

    const marketData = bars
      .sort((a, b) => Math.abs(b.momentum) - Math.abs(a.momentum))
      .slice(0, 12)
      .map(b =>
        `${b.symbol}: price=$${b.price.toFixed(2)} sma20=$${b.sma20.toFixed(2)} ` +
        `momentum=${b.momentum.toFixed(1)}% volRatio=${b.volumeRatio.toFixed(2)}x`
      )
      .join('\n')

    const res = await this.ai.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: PROMPT.replace('{MARKET_DATA}', marketData) }],
      max_tokens: 600,
      temperature: 0.3,
    })

    const raw = (res.choices[0]?.message?.content ?? '[]')
      .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()

    const picks: AnalystPick[] = JSON.parse(raw)
    return picks.filter(p => p.confidence >= 0.6)
  }

  async savePicks(db: PoolClient, picks: AnalystPick[]): Promise<void> {
    for (const p of picks) {
      await db.query(
        `INSERT INTO analyst_picks
           (symbol, direction, entry_price, target_price, stop_loss, confidence, risk_level, reason, asset_class)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [p.symbol, p.direction, p.entry, p.target, p.stopLoss, p.confidence, p.riskLevel, p.reason, p.assetClass]
      )
    }
  }
}
