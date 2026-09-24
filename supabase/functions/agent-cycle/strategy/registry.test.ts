import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import {
  checkStrategyDataSufficiency,
  clearsEntryTradeabilityFloor,
  managementAtrPctFor,
  protectionForEntry,
  regimeContextFor,
  strategyFor,
} from './registry.ts'
import type { NormalizedMarketData, OhlcCandle } from '../../../../src/shared/market-data/types.ts'
import type { IntradayMarketData } from './aggressive/types.ts'

function candle(i: number, price: number): OhlcCandle {
  return { timestamp: new Date(Date.UTC(2026, 8, 23) + i * 1_800_000).toISOString(), open: price, high: price + 1, low: price - 1, close: price }
}

function dailyPoint(i: number, close: number): { timestamp: string; close: number } {
  return { timestamp: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString(), close }
}

function marketData(overrides: Partial<NormalizedMarketData> = {}): NormalizedMarketData {
  const dailyCloseSeries = Array.from({ length: 55 }, (_, i) => dailyPoint(i, 100))
  const candles = Array.from({ length: 20 }, (_, i) => candle(i, 100))
  return {
    asset: 'BTC',
    provider: 'coingecko',
    dataAsOf: '2026-09-23T00:00:00.000Z',
    fetchedAt: '2026-09-23T00:00:00.000Z',
    price: 100,
    change1hPct: null,
    change24hPct: null,
    change7dPct: null,
    candles,
    closeSeries: Array.from({ length: 60 }, (_, i) => ({ timestamp: candle(i, 100).timestamp, close: 100 })),
    volumeSeries: Array.from({ length: 60 }, (_, i) => ({ timestamp: candle(i, 100).timestamp, volume: 1000 })),
    dailyCloseSeries,
    ...overrides,
  }
}

function intraday(overrides: Partial<IntradayMarketData> = {}): IntradayMarketData {
  const ohlc30m = Array.from({ length: 20 }, (_, i) => candle(i, 100))
  const spot5m = Array.from({ length: 30 }, (_, i) => ({ timestamp: new Date(Date.UTC(2026, 8, 23) + i * 300_000).toISOString(), price: 100, volume: 10 }))
  return { asset: 'BTC', ohlc30m, spot5m, ...overrides }
}

// --- strategyFor: a thin pass-through, sanity only ------------------------

Deno.test('strategyFor: returns the correct definition per profile', () => {
  assertEquals(strategyFor('balanced').strategyVersion, 'v1-regime')
  assertEquals(strategyFor('aggressive').strategyVersion, 'v3-jev-intraday-30m')
})

// --- checkStrategyDataSufficiency: the profile-conditional freshness fix --

Deno.test('checkStrategyDataSufficiency: balanced requires 50 daily bars — the ORIGINAL rule, unmoved', () => {
  const short = marketData({ dailyCloseSeries: Array.from({ length: 40 }, (_, i) => dailyPoint(i, 100)) })
  const result = checkStrategyDataSufficiency('balanced', short, undefined)
  assertEquals(result.ok, false)
  assertEquals(result.reason?.includes('50'), true)
})

Deno.test('checkStrategyDataSufficiency: balanced with a full 55-bar daily series passes, regardless of intraday data (never fetched for balanced)', () => {
  const result = checkStrategyDataSufficiency('balanced', marketData(), undefined)
  assertEquals(result.ok, true)
})

Deno.test('checkStrategyDataSufficiency: aggressive with a SHORT daily series still passes — the 50-bar rule must never gate this profile', () => {
  const shortDaily = marketData({ dailyCloseSeries: Array.from({ length: 5 }, (_, i) => dailyPoint(i, 100)) })
  const result = checkStrategyDataSufficiency('aggressive', shortDaily, intraday())
  assertEquals(result.ok, true, 'a short daily series must not block Aggressive — the 50DMA is context only for this profile')
})

Deno.test('checkStrategyDataSufficiency: aggressive with no intraday data at all fails closed', () => {
  const result = checkStrategyDataSufficiency('aggressive', marketData(), undefined)
  assertEquals(result.ok, false)
})

Deno.test('checkStrategyDataSufficiency: aggressive with too few 30m bars fails closed', () => {
  const thin = intraday({ ohlc30m: Array.from({ length: 5 }, (_, i) => candle(i, 100)) })
  const result = checkStrategyDataSufficiency('aggressive', marketData(), thin)
  assertEquals(result.ok, false)
  assertEquals(result.reason?.includes('30m'), true)
})

Deno.test('checkStrategyDataSufficiency: aggressive with too few 5m points fails closed', () => {
  const thin = intraday({ spot5m: Array.from({ length: 5 }, (_, i) => ({ timestamp: new Date(Date.UTC(2026, 8, 23) + i * 300_000).toISOString(), price: 100, volume: 10 })) })
  const result = checkStrategyDataSufficiency('aggressive', marketData(), thin)
  assertEquals(result.ok, false)
  assertEquals(result.reason?.includes('5m'), true)
})

// --- regimeContextFor: available as context, computed identically to before

Deno.test('regimeContextFor: a full daily series returns the same RegimeResult evaluateTrendRegime always has', () => {
  const result = regimeContextFor(marketData())
  assertEquals(result?.regime, 'DOWN') // close(100) is NOT strictly > MA(100) -> DOWN, per regime.ts's own strict '>' rule
})

Deno.test('regimeContextFor: a short daily series returns null rather than throwing — safe to call unconditionally for either profile', () => {
  const short = marketData({ dailyCloseSeries: Array.from({ length: 10 }, (_, i) => dailyPoint(i, 100)) })
  assertEquals(regimeContextFor(short), null)
})

// --- managementAtrPctFor: 4h candles for balanced, 30m for aggressive -----

Deno.test('managementAtrPctFor: balanced reads the 4-hourly candles field, never intraday data', () => {
  const result = managementAtrPctFor('balanced', marketData(), undefined)
  assertEquals(typeof result, 'number')
})

Deno.test('managementAtrPctFor: aggressive reads the 30m intraday OHLC, never the 4-hourly candles', () => {
  const result = managementAtrPctFor('aggressive', marketData(), intraday())
  assertEquals(typeof result, 'number')
})

Deno.test('managementAtrPctFor: aggressive throws if no intraday data is available — never silently falls back to the 4h figure', () => {
  let threw = false
  try {
    managementAtrPctFor('aggressive', marketData(), undefined)
  } catch {
    threw = true
  }
  assertEquals(threw, true)
})

// --- protectionForEntry: origination only, correct formula per profile ----

Deno.test('protectionForEntry: balanced calls the PASSED-IN stopLossPctFor/takeProfitPctFor unchanged — proves registry.ts does not reimplement strategy/rules.ts', () => {
  let calledWith: number | null = null
  const stopLossPctFor = (atrPct: number) => { calledWith = atrPct; return 0.03 }
  const takeProfitPctFor = (stopLossPct: number) => 6 * stopLossPct
  const result = protectionForEntry('balanced', 1.5, stopLossPctFor, takeProfitPctFor)
  assertEquals(calledWith, 1.5)
  assertAlmostEquals(result.stopLossPct, 0.03, 1e-12)
  assertAlmostEquals(result.takeProfitPct, 0.18, 1e-12)
})

Deno.test('protectionForEntry: aggressive NEVER calls the passed-in balanced formula, uses its own ATR30 regime instead', () => {
  let balancedFormulaCalled = false
  const stopLossPctFor = () => { balancedFormulaCalled = true; return 0.025 }
  const takeProfitPctFor = (s: number) => 6 * s
  const result = protectionForEntry('aggressive', 0.60, stopLossPctFor, takeProfitPctFor)
  assertEquals(balancedFormulaCalled, false)
  assertAlmostEquals(result.stopLossPct, 0.012, 1e-12) // 2*0.006, matches aggressiveProtectionFor's own test
  assertAlmostEquals(result.takeProfitPct, 0.024, 1e-12)
})

// --- clearsEntryTradeabilityFloor: balanced has no such concept -----------

Deno.test('clearsEntryTradeabilityFloor: always true for balanced, regardless of the numbers passed', () => {
  assertEquals(clearsEntryTradeabilityFloor('balanced', 0.0001, 100), true)
})

Deno.test('clearsEntryTradeabilityFloor: aggressive applies the real K=3 floor', () => {
  assertEquals(clearsEntryTradeabilityFloor('aggressive', 0.016, 0.003), true)
  assertEquals(clearsEntryTradeabilityFloor('aggressive', 0.004, 0.003), false)
})

// deterministicTighteningFor was retired 2026-09-23 — superseded by the
// monitor-enforced giveback ratchet (strategy/aggressive/protection.ts's
// rawGivebackFloor/nextGivebackFloor/shouldExecuteGivebackExit, tested in
// protection.test.ts; orchestrated in position-monitor/giveback.test.ts).
// See registry.ts's own comment at the old call site for why.
