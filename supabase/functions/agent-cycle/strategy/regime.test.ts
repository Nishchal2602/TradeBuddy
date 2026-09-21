import { assertAlmostEquals, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { evaluateTrendRegime, simpleMovingAverage } from './regime.ts'
import { InsufficientDataError } from '../indicators/calculate.ts'
import { TREND_MA_LOOKBACK_DAYS } from '../../../../src/shared/strategy/types.ts'

const DAY = 86_400_000

// oldest -> newest, matching NormalizedMarketData.dailyCloseSeries's own
// ordering contract.
function series(closes: number[], endIso = '2026-09-21T00:00:00.000Z'): { timestamp: string; close: number }[] {
  const end = new Date(endIso).getTime()
  return closes.map((close, i) => ({
    timestamp: new Date(end - (closes.length - 1 - i) * DAY).toISOString(),
    close,
  }))
}

// --- simpleMovingAverage -------------------------------------------------

Deno.test('simpleMovingAverage: exact average of a flat series', () => {
  assertEquals(simpleMovingAverage([10, 10, 10, 10], 4), 10)
})

Deno.test('simpleMovingAverage: only the trailing `period` values are used, older ones ignored', () => {
  // If the first 999 were included, the average would be nowhere near 10.
  const closes = [999, 999, 999, 10, 10]
  assertEquals(simpleMovingAverage(closes, 2), 10)
})

Deno.test('simpleMovingAverage: independently-verified worked example', () => {
  // mean(1..10) = 5.5, computed independently, not just transcribed.
  const closes = Array.from({ length: 10 }, (_, i) => i + 1)
  assertAlmostEquals(simpleMovingAverage(closes, 10), 5.5, 1e-9)
})

Deno.test('simpleMovingAverage: fewer points than the period throws InsufficientDataError', () => {
  assertThrows(() => simpleMovingAverage([1, 2, 3], 4), InsufficientDataError)
})

Deno.test('simpleMovingAverage: exactly `period` points is valid (boundary inclusive)', () => {
  assertEquals(simpleMovingAverage([1, 2, 3], 3), 2)
})

// --- evaluateTrendRegime --------------------------------------------------

Deno.test('evaluateTrendRegime: close strictly above the 50-day MA is UP', () => {
  const closes = Array.from({ length: 50 }, () => 100)
  closes[closes.length - 1] = 110 // last close pulled above the flat-100 MA
  const result = evaluateTrendRegime(series(closes))
  assertEquals(result.regime, 'UP')
  assertEquals(result.dailyClose, 110)
  assertEquals(result.barsUsed, TREND_MA_LOOKBACK_DAYS)
})

Deno.test('evaluateTrendRegime: close strictly below the 50-day MA is DOWN', () => {
  const closes = Array.from({ length: 50 }, () => 100)
  closes[closes.length - 1] = 90
  const result = evaluateTrendRegime(series(closes))
  assertEquals(result.regime, 'DOWN')
})

Deno.test('evaluateTrendRegime: close exactly equal to the MA is DOWN, not UP — spec §7 is strict `>`', () => {
  // A flat series' MA equals every point in it, including the last.
  const closes = Array.from({ length: 50 }, () => 100)
  const result = evaluateTrendRegime(series(closes))
  assertEquals(result.dailyMa, 100)
  assertEquals(result.dailyClose, 100)
  assertEquals(result.regime, 'DOWN')
})

Deno.test('evaluateTrendRegime: fewer than 50 closed daily bars fails closed', () => {
  const closes = Array.from({ length: 49 }, () => 100)
  assertThrows(() => evaluateTrendRegime(series(closes)), InsufficientDataError)
})

Deno.test('evaluateTrendRegime: exactly 50 closed daily bars is valid (boundary inclusive)', () => {
  const closes = Array.from({ length: 50 }, () => 100)
  const result = evaluateTrendRegime(series(closes))
  assertEquals(result.barsUsed, 50)
})

Deno.test('evaluateTrendRegime: more than 50 bars only uses the trailing 50 for the MA', () => {
  // 69 old points at 1000 would swamp the average if included; the last 50
  // (all 100) must dominate instead.
  const closes = [...Array.from({ length: 69 }, () => 1000), ...Array.from({ length: 50 }, () => 100)]
  const result = evaluateTrendRegime(series(closes))
  assertEquals(result.dailyMa, 100)
})

Deno.test('evaluateTrendRegime: regime transition — a genuine uptrend crossing above its own MA', () => {
  // A steadily rising series: the last close sits above the trailing
  // 50-day average of a series that was lower earlier on.
  const closes = Array.from({ length: 50 }, (_, i) => 80 + i) // 80..129
  const result = evaluateTrendRegime(series(closes))
  // mean(80..129) = 104.5, last close = 129 -> comfortably above.
  assertAlmostEquals(result.dailyMa, 104.5, 1e-9)
  assertEquals(result.regime, 'UP')
})

Deno.test('evaluateTrendRegime: regime transition — a genuine downtrend crossing below its own MA', () => {
  const closes = Array.from({ length: 50 }, (_, i) => 129 - i) // 129..80
  const result = evaluateTrendRegime(series(closes))
  assertAlmostEquals(result.dailyMa, 104.5, 1e-9)
  assertEquals(result.regime, 'DOWN')
})

Deno.test('evaluateTrendRegime: first-activation semantics — long-established UP regime is eligible immediately, no crossover required', () => {
  // State-based per the approved plan: BTC has been above its 50-day MA
  // for the entire fixture window (not just the most recent bar) — the
  // function still reports UP on the very first evaluation, with no
  // concept of "how long has this been true" or "did it just cross".
  const closes = Array.from({ length: 50 }, (_, i) => 100 + i * 0.5) // steady climb throughout
  const result = evaluateTrendRegime(series(closes))
  assertEquals(result.regime, 'UP')
})
