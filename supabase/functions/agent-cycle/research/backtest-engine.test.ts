import { assertEquals } from 'jsr:@std/assert@1'
import { runBacktest } from './backtest-engine.ts'
import type { BacktestParams } from './backtest-engine.ts'
import { V4_COMPAT_CONFIG } from '../../../../src/shared/strategy/config-presets.ts'
import type { HistoricalBarRow } from './db/historical-bars.ts'
import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'

const DAY = 86_400_000
const HOUR = 3_600_000
const HALF_HOUR = 1_800_000

function row(asset: AssetSymbol, timeframe: HistoricalBarRow['timeframe'], closeTime: string, o: number, h: number, l: number, c: number, volume = 10): HistoricalBarRow {
  return { asset, timeframe, openTime: closeTime, closeTime, open: o, high: h, low: l, close: c, volume }
}

function dailyBars(asset: AssetSymbol, n: number, closes: (i: number) => number, endIso = '2026-09-21T00:00:00.000Z'): HistoricalBarRow[] {
  const end = new Date(endIso).getTime()
  return Array.from({ length: n }, (_, i) => {
    const c = closes(i)
    const t = new Date(end - (n - 1 - i) * DAY).toISOString()
    return row(asset, '1d', t, c, c, c, c)
  })
}

function fourHBars(asset: AssetSymbol, n: number, closes: (i: number) => number, startIso = '2026-08-01T00:00:00.000Z'): HistoricalBarRow[] {
  const start = new Date(startIso).getTime()
  return Array.from({ length: n }, (_, i) => {
    const c = closes(i)
    const t = new Date(start + i * 4 * HOUR).toISOString()
    return row(asset, '4h', t, c, c, c, c)
  })
}

function hourlyBars(asset: AssetSymbol, n: number, price: number, startIso = '2026-09-19T00:00:00.000Z'): HistoricalBarRow[] {
  const start = new Date(startIso).getTime()
  return Array.from({ length: n }, (_, i) => row(asset, '1h', new Date(start + i * HOUR).toISOString(), price, price, price, price))
}

// --- The default happy-path dataset: UP daily regime, rising 4h (LONG
// bias), 16 flat 30m bars, a breakout+volume-spike on bar 16, then two
// more bars that run price up far enough to hit the take-profit. ---

function defaultBars(asset: AssetSymbol = 'BTC'): HistoricalBarRow[] {
  const daily = dailyBars(asset, 60, (i) => 80 + i)
  const fourH = fourHBars(asset, 60, (i) => 80 + i)
  const hourly = hourlyBars(asset, 20, 100)

  const start = new Date('2026-09-23T00:00:00.000Z').getTime()
  const thirtyM: HistoricalBarRow[] = []
  for (let i = 0; i < 16; i++) {
    const t = new Date(start + i * HALF_HOUR).toISOString()
    thirtyM.push(row(asset, '30m', t, 100, 100, 100, 100, 10))
  }
  // bar 15 (index 15, the 16th bar): breaks the prior-8-bar high (all
  // 100) with a volume spike (trailing-4-bar mean = (10+10+10+50)/4=20;
  // latest/mean = 2.5 >= V4_COMPAT_CONFIG's 1.2 floor).
  thirtyM[15] = row(asset, '30m', thirtyM[15]!.closeTime, 105, 112, 104, 110, 50)
  // bar 16: price continues up, clearing the take-profit (110 * 1.024 =
  // 112.64 at the 1.2% stop floor / 2.0 default RR).
  thirtyM.push(row(asset, '30m', new Date(start + 16 * HALF_HOUR).toISOString(), 110, 120, 109, 115, 10))

  return [...daily, ...fourH, ...hourly, ...thirtyM]
}

function baseParams(overrides: Partial<BacktestParams> = {}): BacktestParams {
  return {
    assets: ['BTC'],
    config: V4_COMPAT_CONFIG,
    startingCapitalUsd: 10_000,
    feeBps: 10,
    slippageBps: 5,
    effectiveMinConfidence: 0,
    slTpBounds: { minStopLossPct: 0.005, maxStopLossPct: 0.15, minTakeProfitPct: 0.005, maxTakeProfitPct: 0.5 },
    portfolioRiskCeilingMultiplier: 1.5,
    drawdownBreakerFloorPct: 0.5,
    minTradeNotionalPct: 0.01,
    minTradeNotionalUsd: 25,
    shortFundingBpsPerDayByAsset: {},
    ...overrides,
  }
}

Deno.test('runBacktest: opens a breakout_long position and closes it via take-profit on a later bar', () => {
  const result = runBacktest({ BTC: defaultBars() }, baseParams())

  assertEquals(result.closedTrades.length, 1)
  const trade = result.closedTrades[0]!
  assertEquals(trade.asset, 'BTC')
  assertEquals(trade.direction, 'long')
  assertEquals(trade.armId, 'breakout_long')
  assertEquals(trade.closeReason, 'take_profit')
  assertEquals(trade.realizedPnl > 0, true)
  assertEquals(result.openAtEnd.length, 0)
})

Deno.test('runBacktest: NAV series has one entry per master (BTC) 30m tick', () => {
  const bars = defaultBars()
  const thirtyMCount = bars.filter((b) => b.timeframe === '30m').length
  const result = runBacktest({ BTC: bars }, baseParams())
  assertEquals(result.navSeries.length, thirtyMCount)
})

Deno.test('runBacktest: starting NAV (before any trade) equals starting capital', () => {
  const bars = defaultBars()
  const result = runBacktest({ BTC: bars }, baseParams())
  // The first 15 ticks (flat bars, no breakout yet) should show NAV
  // unchanged at the starting capital -- no position ever opened yet.
  assertEquals(result.navSeries[0]!.nav, 10_000)
  assertEquals(result.navSeries[14]!.nav, 10_000)
})

Deno.test('runBacktest: a stop-loss exit is recorded with a negative realized P&L', () => {
  const bars = defaultBars()
  // Replace the follow-up bar so price instead crashes through the stop
  // (108.68 at the 1.2% floor) rather than the target.
  const idx = bars.findIndex((b) => b.timeframe === '30m' && b.open === 110 && b.high === 120)
  bars[idx] = row('BTC', '30m', bars[idx]!.closeTime, 110, 110, 100, 105, 10)

  const result = runBacktest({ BTC: bars }, baseParams())
  assertEquals(result.closedTrades.length, 1)
  assertEquals(result.closedTrades[0]!.closeReason, 'stop_loss')
  assertEquals(result.closedTrades[0]!.realizedPnl < 0, true)
})

Deno.test('runBacktest: no breakout at all -> zero trades, flat NAV throughout', () => {
  const asset: AssetSymbol = 'BTC'
  const daily = dailyBars(asset, 60, (i) => 80 + i)
  const fourH = fourHBars(asset, 60, (i) => 80 + i)
  const hourly = hourlyBars(asset, 20, 100)
  const start = new Date('2026-09-23T00:00:00.000Z').getTime()
  const thirtyM = Array.from({ length: 20 }, (_, i) => row(asset, '30m', new Date(start + i * HALF_HOUR).toISOString(), 100, 100, 100, 100, 10))

  const result = runBacktest({ BTC: [...daily, ...fourH, ...hourly, ...thirtyM] }, baseParams())
  assertEquals(result.closedTrades.length, 0)
  assertEquals(result.openAtEnd.length, 0)
  assertEquals(result.navSeries.every((p) => p.nav === 10_000), true)
})

Deno.test('runBacktest: shortEnabled=false suppresses execution but the opportunity-consumption lifecycle still advances (no immediate re-detection of the identical bar)', () => {
  const asset: AssetSymbol = 'BTC'
  // DOWN daily + falling 4h -> SHORT bias.
  const daily = dailyBars(asset, 60, (i) => 129 - i)
  const fourH = fourHBars(asset, 60, (i) => 129 - i)
  const hourly = hourlyBars(asset, 20, 100)
  const start = new Date('2026-09-23T00:00:00.000Z').getTime()
  const thirtyM: HistoricalBarRow[] = Array.from({ length: 16 }, (_, i) => row(asset, '30m', new Date(start + i * HALF_HOUR).toISOString(), 100, 100, 100, 100, 10))
  thirtyM[15] = row(asset, '30m', thirtyM[15]!.closeTime, 95, 96, 88, 90, 50) // breaks the prior 8-bar low, volume spike

  const config = { ...V4_COMPAT_CONFIG, shortEnabled: false }
  const result = runBacktest({ BTC: [...daily, ...fourH, ...hourly, ...thirtyM] }, baseParams({ config }))

  assertEquals(result.closedTrades.length, 0)
  assertEquals(result.openAtEnd.length, 0)
  assertEquals(result.navSeries.every((p) => p.nav === 10_000), true)
})

Deno.test('runBacktest: two assets run independently; the asset with MORE 30m coverage is correctly selected as the master clock', () => {
  const btcBars = defaultBars('BTC') // 17 x 30m bars (0-16): breakout at 15, take-profit close at 16
  // ETH's own coverage ENDS one bar earlier (no bar 16) -- its breakout
  // at bar 15 still satisfies sufficiency (16 bars >= MIN_BARS_FOR_WINDOW_
  // SCAN=15) and still opens a position, but with no follow-up bar it
  // never gets the chance to close within this run.
  const ethBars = defaultBars('ETH').filter((b) => !(b.timeframe === '30m' && b.open === 110 && b.high === 120))

  const result = runBacktest({ BTC: btcBars, ETH: ethBars }, baseParams({ assets: ['BTC', 'ETH'] }))
  const btcTrades = result.closedTrades.filter((t) => t.asset === 'BTC')
  const ethTrades = result.closedTrades.filter((t) => t.asset === 'ETH')
  assertEquals(btcTrades.length, 1)
  assertEquals(ethTrades.length, 0)
  assertEquals(result.openAtEnd.length, 1)
  assertEquals(result.openAtEnd[0]!.asset, 'ETH')
  assertEquals(result.openAtEnd[0]!.armId, 'breakout_long')
  // BTC has 17 30m bars vs ETH's 16 -- BTC must be the master clock.
  const btcThirtyMCount = btcBars.filter((b) => b.timeframe === '30m').length
  assertEquals(result.navSeries.length, btcThirtyMCount)
})
