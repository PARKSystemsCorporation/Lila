import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PoolClient } from 'pg'
import * as Alpaca from '../platforms/alpaca'

// Mock the Alpaca platform module the engine imports (`./platforms/alpaca`).
vi.mock('../platforms/alpaca', () => ({
  getPositions: vi.fn(),
  closePosition: vi.fn(),
  isMarketOpen: vi.fn(async () => false),
  getAccount: vi.fn(),
  placeOrder: vi.fn(),
}))

import { TradingEngine } from '../trading-engine'

const getPositions = vi.mocked(Alpaca.getPositions)
const closePosition = vi.mocked(Alpaca.closePosition)

interface QueryCall { sql: string; params?: unknown[] }

// Fake PoolClient: returns one open tracked position for the SELECT,
// records every query so we can assert the close UPDATE never fires.
function fakeDb() {
  const calls: QueryCall[] = []
  return {
    calls,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      if (/SELECT \* FROM lila_positions/.test(sql)) {
        return { rows: [{ id: 7, entry_price: '100', target_price: null, stop_loss: null }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }) as unknown as PoolClient['query'],
  }
}

const POSITION: Alpaca.AlpacaPosition = {
  symbol: 'AAPL', qty: '1', avg_entry_price: '100', current_price: '90',
  unrealized_pl: '-10', unrealized_plpc: '-0.10', side: 'long',
}

describe('TradingEngine — exchange close failure must not mark the DB row closed', () => {
  beforeEach(() => {
    process.env.ALPACA_API_KEY = 'test-key'
    getPositions.mockReset()
    closePosition.mockReset()
  })
  afterEach(() => {
    delete process.env.ALPACA_API_KEY
  })

  it('leaves the position open and surfaces a warn when closePosition throws', async () => {
    // Position down 10% → trips the 3% default stop.
    getPositions.mockResolvedValue([POSITION])
    closePosition.mockRejectedValue(new Error('alpaca 503'))

    const db = fakeDb()
    const engine = new TradingEngine()
    const res = await engine.tick(db as unknown as PoolClient)

    expect(closePosition).toHaveBeenCalledWith('AAPL')
    expect(res?.action).toBe('error')
    expect(res?.logType).toBe('warn')
    // The critical invariant: no UPDATE ... status='closed' was issued.
    const closedUpdate = db.calls.find(c => /UPDATE lila_positions SET status='closed'/.test(c.sql))
    expect(closedUpdate).toBeUndefined()
  })

  it('marks the row closed only when the exchange close succeeds', async () => {
    getPositions.mockResolvedValue([POSITION])
    closePosition.mockResolvedValue(true)

    const db = fakeDb()
    const engine = new TradingEngine()
    const res = await engine.tick(db as unknown as PoolClient)

    expect(res?.action).toBe('sold')
    const closedUpdate = db.calls.find(c => /UPDATE lila_positions SET status='closed'/.test(c.sql))
    expect(closedUpdate).toBeDefined()
    expect(closedUpdate?.params).toEqual([-10, 7])
  })
})
