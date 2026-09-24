import { assertAlmostEquals, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { computeIntradayFeatures } from './features.ts'
import { InsufficientDataError } from '../../indicators/calculate.ts'
import type { IntradaySpotPoint } from './types.ts'

// Every expected value below was computed independently (Python-equivalent
// arithmetic worked by hand and cross-checked), not derived from the
// implementation — same discipline this codebase uses throughout
// (indicators/calculate.test.ts's own header comment states the rule).

// Builds a flat-price, flat-volume series of `n` points 5 minutes apart,
// then applies `overrides` by absolute index — lets each test change only
// the handful of points it cares about while keeping the rest neutral.
function series(n: number, basePrice: number, baseVolume: number, overrides: Record<number, Partial<IntradaySpotPoint>> = {}): IntradaySpotPoint[] {
  const points: IntradaySpotPoint[] = []
  for (let i = 0; i < n; i++) {
    const ts = new Date(Date.UTC(2026, 8, 23, 0, 0, 0) + i * 300_000).toISOString()
    points.push({ timestamp: ts, price: basePrice, volume: baseVolume, ...overrides[i] })
  }
  return points
}

Deno.test('computeIntradayFeatures: fewer than 25 points throws InsufficientDataError', () => {
  assertThrows(() => computeIntradayFeatures(series(24, 100, 10)), InsufficientDataError)
})

Deno.test('computeIntradayFeatures: exactly 25 points is valid (boundary inclusive)', () => {
  const result = computeIntradayFeatures(series(25, 100, 10))
  assertEquals(typeof result.ret60mPct, 'number')
})

Deno.test('ret15mPct/ret30mPct/ret60mPct: exact percentage returns over 3/6/12 points back', () => {
  // 30 flat points at 100, then bump the LAST point to 105 — a clean +5%
  // move visible identically at every horizon since all reference points
  // (3/6/12 back) are still 100.
  const points = series(30, 100, 10, { 29: { price: 105 } })
  const result = computeIntradayFeatures(points)
  assertAlmostEquals(result.ret15mPct, 5, 1e-9)
  assertAlmostEquals(result.ret30mPct, 5, 1e-9)
  assertAlmostEquals(result.ret60mPct, 5, 1e-9)
})

Deno.test('ret15mPct: distinguishes a move that happened OUTSIDE the 15-minute window from one inside it', () => {
  // Price rose to 110 at index 20, then held flat through index 29 (the
  // latest point). The last 3 points (15m) are all 110 -> ret15m = 0%.
  // The point 6 back (index 23) is also 110 -> ret30m = 0% too. The point
  // 12 back (index 17) is still 100 -> ret60m sees the full +10% move.
  const overrides: Record<number, Partial<IntradaySpotPoint>> = {}
  for (let i = 20; i < 30; i++) overrides[i] = { price: 110 }
  const points = series(30, 100, 10, overrides)
  const result = computeIntradayFeatures(points)
  assertAlmostEquals(result.ret15mPct, 0, 1e-9)
  assertAlmostEquals(result.ret30mPct, 0, 1e-9)
  assertAlmostEquals(result.ret60mPct, 10, 1e-9)
})

Deno.test('realizedVol5m: zero for a perfectly flat series', () => {
  const result = computeIntradayFeatures(series(30, 100, 10))
  assertAlmostEquals(result.realizedVol5m, 0, 1e-12)
})

Deno.test('realizedVol5m: a genuinely alternating series produces the independently-computed stdev', () => {
  // Alternate 100/101 for the trailing 25 points used in the vol window.
  // log(101/100) = 0.00995033..., log(100/101) = -0.00995033...
  // Every consecutive pair alternates sign with equal magnitude, so the
  // mean is ~0 and variance ~= (0.00995033)^2 -> stdev ~= 0.00995033.
  const overrides: Record<number, Partial<IntradaySpotPoint>> = {}
  for (let i = 0; i < 30; i++) overrides[i] = { price: i % 2 === 0 ? 100 : 101 }
  const points = series(30, 100, 10, overrides)
  const result = computeIntradayFeatures(points)
  assertAlmostEquals(result.realizedVol5m, 0.00995033, 1e-6)
})

Deno.test('volumeTrendRatio: exactly 1 for uniform volume', () => {
  const result = computeIntradayFeatures(series(30, 100, 50))
  assertAlmostEquals(result.volumeTrendRatio, 1, 1e-12)
})

Deno.test('volumeTrendRatio: elevated recent volume produces a ratio > 1, computed exactly', () => {
  // Last 6 points at volume 100, everything before (in the 24-window) at
  // volume 10. mean(last 6) = 100. mean(last 24) = (6*100 + 18*10)/24 =
  // (600+180)/24 = 780/24 = 32.5. ratio = 100/32.5 = 3.076923...
  const overrides: Record<number, Partial<IntradaySpotPoint>> = {}
  for (let i = 24; i < 30; i++) overrides[i] = { volume: 100 }
  const points = series(30, 100, 10, overrides)
  const result = computeIntradayFeatures(points)
  assertAlmostEquals(result.volumeTrendRatio, 100 / 32.5, 1e-9)
})

Deno.test('volumeTrendRatio: zero long-window volume is treated as neutral (1), not a divide-by-zero throw', () => {
  const result = computeIntradayFeatures(series(30, 100, 0))
  assertEquals(result.volumeTrendRatio, 1)
})

Deno.test('sampledDayHighPct/LowPct: current price equal to both the max and min of a flat series is 0/0', () => {
  const result = computeIntradayFeatures(series(30, 100, 10))
  assertAlmostEquals(result.sampledDayHighPct, 0, 1e-12)
  assertAlmostEquals(result.sampledDayLowPct, 0, 1e-12)
})

Deno.test('sampledDayHighPct: negative when current price sits below an earlier peak', () => {
  // Peak of 120 at index 10, current (last) price back down to 100.
  // sampledDayHighPct = (100-120)/120*100 = -16.666...
  const points = series(30, 100, 10, { 10: { price: 120 } })
  const result = computeIntradayFeatures(points)
  assertAlmostEquals(result.sampledDayHighPct, ((100 - 120) / 120) * 100, 1e-9)
  assertEquals(result.sampledDayHighPct < 0, true)
})

Deno.test('sampledDayLowPct: positive when current price sits above an earlier trough', () => {
  // Trough of 80 at index 10, current price back at 100.
  // sampledDayLowPct = (100-80)/80*100 = 25.
  const points = series(30, 100, 10, { 10: { price: 80 } })
  const result = computeIntradayFeatures(points)
  assertAlmostEquals(result.sampledDayLowPct, 25, 1e-9)
  assertEquals(result.sampledDayLowPct > 0, true)
})

Deno.test('sampledDayHighPct: current price AS the high is exactly 0, never positive (current cannot exceed max of a series containing itself)', () => {
  const points = series(30, 100, 10, { 29: { price: 200 } }) // last point IS the max
  const result = computeIntradayFeatures(points)
  assertAlmostEquals(result.sampledDayHighPct, 0, 1e-12)
})
