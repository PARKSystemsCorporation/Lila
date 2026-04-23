const TRADE_BASE = process.env.ALPACA_PAPER !== 'false'
  ? 'https://paper-api.alpaca.markets'
  : 'https://api.alpaca.markets'

const DATA_BASE = 'https://data.alpaca.markets'

function key() { return process.env.ALPACA_API_KEY ?? process.env.APCA_API_KEY_ID ?? '' }
function secret() { return process.env.ALPACA_SECRET_KEY ?? process.env.APCA_API_SECRET_KEY ?? '' }

function tradeHeaders() {
  return { 'APCA-API-KEY-ID': key(), 'APCA-API-SECRET-KEY': secret(), 'Content-Type': 'application/json' }
}
function dataHeaders() {
  return { 'APCA-API-KEY-ID': key(), 'APCA-API-SECRET-KEY': secret() }
}

export interface AlpacaAccount {
  buying_power: string
  equity: string
  cash: string
  portfolio_value: string
  status: string
}

export interface AlpacaPosition {
  symbol: string
  qty: string
  avg_entry_price: string
  current_price: string
  unrealized_pl: string
  unrealized_plpc: string
  side: 'long' | 'short'
}

export interface BarData {
  symbol: string
  price: number
  sma20: number
  momentum: number  // % above/below 20-day SMA
  volume: number
  avgVolume: number
  volumeRatio: number
}

export async function getAccount(): Promise<AlpacaAccount> {
  const res = await fetch(`${TRADE_BASE}/v2/account`, {
    headers: tradeHeaders(), signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Alpaca account: ${res.status}`)
  return res.json()
}

export async function getPositions(): Promise<AlpacaPosition[]> {
  const res = await fetch(`${TRADE_BASE}/v2/positions`, {
    headers: tradeHeaders(), signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Alpaca positions: ${res.status}`)
  return res.json()
}

export async function isMarketOpen(): Promise<boolean> {
  const res = await fetch(`${TRADE_BASE}/v2/clock`, {
    headers: tradeHeaders(), signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) return false
  const c = await res.json()
  return c.is_open === true
}

export interface OrderRequest {
  symbol: string
  notional?: number
  qty?: number
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  limit_price?: number
  time_in_force: 'day' | 'gtc' | 'ioc'
}

export async function placeOrder(order: OrderRequest): Promise<{ id: string; status: string }> {
  const body: Record<string, unknown> = {
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    time_in_force: order.time_in_force,
  }
  if (order.notional) body.notional = order.notional.toFixed(2)
  else if (order.qty) body.qty = String(order.qty)
  if (order.limit_price) body.limit_price = order.limit_price.toFixed(4)

  const res = await fetch(`${TRADE_BASE}/v2/orders`, {
    method: 'POST',
    headers: tradeHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Alpaca order: ${res.status} ${err}`)
  }
  return res.json()
}

export async function closePosition(symbol: string): Promise<boolean> {
  const res = await fetch(`${TRADE_BASE}/v2/positions/${symbol}`, {
    method: 'DELETE', headers: tradeHeaders(), signal: AbortSignal.timeout(10_000),
  })
  return res.ok
}

export interface PortfolioHistory {
  timestamp: number[]        // unix seconds
  equity: number[]
  profit_loss: number[]
  profit_loss_pct: number[]
  base_value: number
  timeframe: string
}

// period: "1D"|"1W"|"1M"|"3M"|"1A"|"all"   timeframe: "1Min"|"5Min"|"15Min"|"1H"|"1D"
export async function getPortfolioHistory(
  period: string = '1M',
  timeframe: string = '1D',
): Promise<PortfolioHistory | null> {
  try {
    const res = await fetch(
      `${TRADE_BASE}/v2/account/portfolio/history?period=${period}&timeframe=${timeframe}&extended_hours=false`,
      { headers: tradeHeaders(), signal: AbortSignal.timeout(10_000) },
    )
    if (!res.ok) return null
    const d = await res.json()
    return {
      timestamp: d.timestamp ?? [],
      equity: (d.equity ?? []).map((v: number | null) => v ?? 0),
      profit_loss: (d.profit_loss ?? []).map((v: number | null) => v ?? 0),
      profit_loss_pct: (d.profit_loss_pct ?? []).map((v: number | null) => v ?? 0),
      base_value: d.base_value ?? 0,
      timeframe: d.timeframe ?? timeframe,
    }
  } catch { return null }
}

export interface NewsItem {
  id: number
  headline: string
  summary: string
  symbols: string[]
  source: string
  created_at: string
}

export async function getNews(symbols: string[], limit = 15): Promise<NewsItem[]> {
  const url = `${DATA_BASE}/v1beta1/news?symbols=${symbols.join(',')}&limit=${limit}&sort=desc`
  const res = await fetch(url, { headers: dataHeaders(), signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`Alpaca news: ${res.status}`)
  const data = await res.json()
  return (data.news ?? []) as NewsItem[]
}

export async function getBars(symbols: string[], limit = 25): Promise<BarData[]> {
  const url = `${DATA_BASE}/v2/stocks/bars?symbols=${symbols.join(',')}&timeframe=1Day&limit=${limit}&feed=iex`
  const res = await fetch(url, { headers: dataHeaders(), signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`Alpaca bars: ${res.status}`)
  const data = await res.json()
  const bars: Record<string, { c: number; v: number }[]> = data.bars ?? {}

  return symbols.flatMap(sym => {
    const b = bars[sym]
    if (!b || b.length < 5) return []
    const closes = b.map(x => x.c)
    const volumes = b.map(x => x.v)
    const price = closes[closes.length - 1]
    const lookback = Math.min(closes.length, 20)
    const sma20 = closes.slice(-lookback).reduce((a, c) => a + c, 0) / lookback
    const avgVol = volumes.slice(-lookback).reduce((a, v) => a + v, 0) / lookback
    const vol = volumes[volumes.length - 1]
    return [{ symbol: sym, price, sma20, momentum: ((price / sma20) - 1) * 100, volume: vol, avgVolume: avgVol, volumeRatio: vol / avgVol }]
  })
}
