import { assertEquals, assertThrows, assertAlmostEquals } from 'jsr:@std/assert@1'
import {
  calculateEMA,
  calculateRSI,
  calculateMACDHistogram,
  calculateATRPercent,
  calculateVolumeRatio,
  calculateDistanceFromSevenDayRange,
  calculateIndicators,
  getRecentCloses,
  InsufficientDataError,
} from './calculate.ts'
import type { OhlcCandle, NormalizedMarketData, VolumePoint } from '../../../../src/shared/market-data/types.ts'

// Every non-trivial expected value below was computed independently in
// Python (progress-tracker.md, indicators unit) — not hand-derived here —
// specifically because the epoch-timestamp bug in Unit 3's own tests came
// from trusting hand arithmetic. Trivial edge cases (constant series, etc.)
// are verifiable by inspection and don't need that cross-check.

function iso(daysAgo: number, hour = 0): string {
  const d = new Date('2026-09-17T00:00:00.000Z')
  d.setUTCDate(d.getUTCDate() - daysAgo)
  d.setUTCHours(hour, 0, 0, 0)
  return d.toISOString()
}

Deno.test('calculateEMA: constant series returns the constant', () => {
  assertEquals(calculateEMA([50, 50, 50, 50, 50], 3), 50)
})

Deno.test('calculateEMA: matches independently computed value', () => {
  // period=3 over [1,2,3,4,5] -> seed SMA(1,2,3)=2, then 3*0.5+2*0.5=3,
  // 4*0.5+3*0.5=3.5... wait: EMA uses the VALUE at each step, not just k.
  // Python reference: series = [None, None, 2.0, 3.0, 4.0]
  assertEquals(calculateEMA([1, 2, 3, 4, 5], 3), 4.0)
})

Deno.test('calculateEMA: throws InsufficientDataError below the period', () => {
  assertThrows(() => calculateEMA([1, 2], 3), InsufficientDataError)
})

Deno.test('calculateRSI: all-gains series is exactly 100', () => {
  assertEquals(calculateRSI([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 14), 100)
})

Deno.test('calculateRSI: all-losses series is exactly 0', () => {
  assertEquals(calculateRSI([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 14), 0)
})

Deno.test('calculateRSI: matches independently computed value', () => {
  const closes = [44, 44.25, 44.5, 43.75, 44.65, 45.12, 45.5, 45.3, 45.8, 46.1, 45.9, 46.3, 46.6, 46.4, 47.0]
  assertAlmostEquals(calculateRSI(closes, 14), 76.31578947368413, 1e-9)
})

Deno.test('calculateMACDHistogram: constant series is exactly 0', () => {
  const closes = new Array(40).fill(100)
  assertEquals(calculateMACDHistogram(closes), 0)
})

Deno.test('calculateMACDHistogram: throws below the 35-point minimum', () => {
  assertThrows(() => calculateMACDHistogram(new Array(34).fill(100)), InsufficientDataError)
})

function candle(high: number, low: number, close: number, timestamp = '2026-01-01T00:00:00.000Z'): OhlcCandle {
  return { timestamp, open: close, high, low, close }
}

Deno.test('calculateATRPercent: zero-range candles is exactly 0', () => {
  const candles = new Array(15).fill(0).map(() => candle(100, 100, 100))
  assertEquals(calculateATRPercent(candles, 14), 0)
})

Deno.test('calculateATRPercent: matches independently computed value', () => {
  const raw: [number, number, number][] = [
    [48.70, 47.79, 48.16], [48.72, 48.14, 48.61], [48.90, 48.39, 48.75], [48.87, 48.37, 48.63],
    [48.82, 48.24, 48.74], [49.05, 48.64, 49.03], [49.20, 48.94, 49.07], [49.35, 48.86, 49.32],
    [49.92, 49.50, 49.91], [50.19, 49.87, 50.13], [50.12, 49.20, 49.53], [49.66, 48.90, 49.50],
    [49.88, 49.43, 49.75], [50.19, 49.73, 50.03], [50.36, 49.26, 50.31],
  ]
  const candles = raw.map(([h, l, c]) => candle(h, l, c))
  assertAlmostEquals(calculateATRPercent(candles, 14), 1.1792194516447017, 1e-9)
})

Deno.test('calculateVolumeRatio: constant volume is exactly 1', () => {
  const series: VolumePoint[] = new Array(20).fill(0).map(() => ({ timestamp: iso(0), volume: 100 }))
  assertEquals(calculateVolumeRatio(series, 20), 1)
})

Deno.test('calculateVolumeRatio: matches independently computed value', () => {
  const series: VolumePoint[] = [
    ...new Array(19).fill(0).map(() => ({ timestamp: iso(0), volume: 100 })),
    { timestamp: iso(0), volume: 200 },
  ]
  assertAlmostEquals(calculateVolumeRatio(series, 20), 1.9047619047619047, 1e-9)
})

Deno.test('calculateVolumeRatio: throws below the period', () => {
  assertThrows(() => calculateVolumeRatio([{ timestamp: iso(0), volume: 1 }], 20), InsufficientDataError)
})

Deno.test('calculateDistanceFromSevenDayRange: excludes candles outside the 7-day window', () => {
  const candles: OhlcCandle[] = [
    candle(999, 1, 500, iso(8)), // 8 days old -> excluded; would otherwise dominate high/low
    candle(120, 80, 100, iso(6)),
    candle(150, 90, 140, iso(3)),
    candle(130, 70, 100, iso(0)),
  ]
  const { distanceFromHighPct, distanceFromLowPct } = calculateDistanceFromSevenDayRange(candles, 100)
  // window high = 150 (iso(3)), window low = 70 (iso(0)) — the iso(8) candle's
  // 999/1 extremes must NOT appear in either number.
  assertAlmostEquals(distanceFromHighPct, ((100 - 150) / 150) * 100, 1e-9)
  assertAlmostEquals(distanceFromLowPct, ((100 - 70) / 70) * 100, 1e-9)
})

Deno.test('calculateDistanceFromSevenDayRange: current price at the high is exactly 0', () => {
  const candles: OhlcCandle[] = [candle(100, 100, 100, iso(1))]
  const { distanceFromHighPct } = calculateDistanceFromSevenDayRange(candles, 100)
  assertEquals(distanceFromHighPct, 0)
})

// --- Orchestration ----------------------------------------------------

function buildNormalizedMarketData(): NormalizedMarketData {
  const closeSeries = new Array(60).fill(0).map((_, i) => ({
    timestamp: iso(0, i % 24),
    close: 100 + Math.sin(i / 5) * 5,
  }))
  const volumeSeries: VolumePoint[] = closeSeries.map((p) => ({ timestamp: p.timestamp, volume: 1000 + (p.close - 100) * 10 }))
  // Plain epoch-ms arithmetic here, not the iso() day/hour field-setter
  // helper — this needs sub-day spacing (45 candles over 7 days), and
  // Date's setUTCDate/setUTCHours rollover semantics for non-integer input
  // aren't worth relying on when a direct ms computation is unambiguous.
  const candlesEndMs = new Date(iso(0)).getTime()
  const candleIntervalMs = (7 * 24 * 60 * 60 * 1000) / 45
  const candles: OhlcCandle[] = new Array(45).fill(0).map((_, i) => {
    const base = 100 + Math.sin(i / 3) * 5
    const timestamp = new Date(candlesEndMs - (44 - i) * candleIntervalMs).toISOString()
    return candle(base + 2, base - 2, base, timestamp)
  })

  return {
    asset: 'BTC',
    provider: 'test-fixture',
    dataAsOf: iso(0),
    fetchedAt: iso(0),
    price: 103,
    change1hPct: 0.1,
    change24hPct: 1.2,
    change7dPct: -0.5,
    candles,
    closeSeries,
    volumeSeries,
  }
}

Deno.test('calculateIndicators: produces a fully-populated, schema-valid result', () => {
  const data = buildNormalizedMarketData()
  const indicators = calculateIndicators(data)

  assertEquals(typeof indicators.rsi14, 'number')
  assertEquals(typeof indicators.ema20, 'number')
  assertEquals(typeof indicators.ema50, 'number')
  assertEquals(typeof indicators.macdHistogram, 'number')
  assertEquals(typeof indicators.atrPct, 'number')
  assertEquals(typeof indicators.volumeRatio, 'number')
  assertEquals(typeof indicators.distanceFromSevenDayHighPct, 'number')
  assertEquals(typeof indicators.distanceFromSevenDayLowPct, 'number')

  for (const value of Object.values(indicators)) {
    assertEquals(Number.isFinite(value), true)
  }
})

Deno.test('getRecentCloses: returns exactly the last N points from closeSeries, not candles', () => {
  const data = buildNormalizedMarketData()
  const recent = getRecentCloses(data, 24)
  assertEquals(recent.length, 24)
  assertEquals(recent[23]!.close, data.closeSeries[data.closeSeries.length - 1]!.close)
})

Deno.test('getRecentCloses: defaults to 24 and clamps to available length', () => {
  const data = buildNormalizedMarketData()
  data.closeSeries = data.closeSeries.slice(0, 10)
  const recent = getRecentCloses(data)
  assertEquals(recent.length, 10)
})
