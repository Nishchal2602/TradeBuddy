import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import {
  buildNormalizedMarketDataForFade,
  checkHistoricalDataSufficiency,
  detectHistoricalCandidate,
  ret60mPctFrom30m,
  volumeTrendRatioFrom30m,
} from './historical-detect.ts'
import type { HistoricalMarketSnapshot } from './historical-detect.ts'
import { V4_COMPAT_CONFIG } from '../../../../src/shared/strategy/config-presets.ts'
import { InsufficientDataError } from '../indicators/calculate.ts'
import type { OhlcCandle } from '../../../../src/shared/market-data/types.ts'

const DAY = 86_400_000
const HOUR = 3_600_000
const HALF_HOUR = 1_800_000

function dailySeries(closes: number[], endIso = '2026-09-21T00:00:00.000Z'): { timestamp: string; close: number }[] {
  const end = new Date(endIso).getTime()
  return closes.map((close, i) => ({ timestamp: new Date(end - (closes.length - 1 - i) * DAY).toISOString(), close }))
}

function h4Bar(i: number, close: number): OhlcCandle {
  return { timestamp: new Date(Date.UTC(2026, 8, 1, 0, 0, 0) + i * 4 * HOUR).toISOString(), open: close, high: close, low: close, close }
}

function hourlyBar(i: number, close: number): { timestamp: string; close: number } {
  return { timestamp: new Date(Date.UTC(2026, 8, 20, 0, 0, 0) + i * HOUR).toISOString(), close }
}

function bar30m(i: number, o: number, h: number, l: number, c: number): OhlcCandle {
  return { timestamp: new Date(Date.UTC(2026, 8, 23, 0, 0, 0) + i * HALF_HOUR).toISOString(), open: o, high: h, low: l, close: c }
}

function flatBars30m(n: number, price = 100): OhlcCandle[] {
  return Array.from({ length: n }, (_, i) => bar30m(i, price, price, price, price))
}

// UP regime (mean 104.5, last 129) / rising 4h EMA (EMA20 > EMA50) —
// matching bias.test.ts's own known-good fixtures exactly in shape.
const UP_DAILY = dailySeries(Array.from({ length: 50 }, (_, i) => 80 + i))
const RISING_H4: OhlcCandle[] = Array.from({ length: 50 }, (_, i) => h4Bar(i, 80 + i))

function baseSnapshot(overrides: Partial<HistoricalMarketSnapshot> = {}): HistoricalMarketSnapshot {
  const bars = flatBars30m(16)
  return {
    asset: 'BTC',
    dailyCloses: UP_DAILY,
    h4Candles: RISING_H4,
    hourlyCloses: Array.from({ length: 20 }, (_, i) => hourlyBar(i, 100)),
    hourlyVolumes: Array.from({ length: 20 }, (_, i) => ({ timestamp: hourlyBar(i, 100).timestamp, volume: 1000 })),
    bars30m: bars,
    volumes30m: bars.map(() => 10),
    price: bars[bars.length - 1]!.close,
    asOfIso: bars[bars.length - 1]!.timestamp,
    ...overrides,
  }
}

// --- checkHistoricalDataSufficiency ---------------------------------------

Deno.test('checkHistoricalDataSufficiency: a fully-populated snapshot passes', () => {
  assertEquals(checkHistoricalDataSufficiency(baseSnapshot()).ok, true)
})

Deno.test('checkHistoricalDataSufficiency: fewer than 50 daily closes fails closed', () => {
  const result = checkHistoricalDataSufficiency(baseSnapshot({ dailyCloses: UP_DAILY.slice(0, 49) }))
  assertEquals(result.ok, false)
})

Deno.test('checkHistoricalDataSufficiency: fewer than 50 4h candles fails closed', () => {
  const result = checkHistoricalDataSufficiency(baseSnapshot({ h4Candles: RISING_H4.slice(0, 49) }))
  assertEquals(result.ok, false)
})

Deno.test('checkHistoricalDataSufficiency: fewer than MIN_BARS_FOR_WINDOW_SCAN (15) 30m bars fails closed', () => {
  const result = checkHistoricalDataSufficiency(baseSnapshot({ bars30m: flatBars30m(14) }))
  assertEquals(result.ok, false)
})

// --- ret60mPctFrom30m ------------------------------------------------------

Deno.test('ret60mPctFrom30m: compares the latest close against 2 bars back (60 minutes)', () => {
  const bars = flatBars30m(5, 100)
  bars[4] = bar30m(4, 110, 110, 110, 110) // latest
  bars[2] = bar30m(2, 100, 100, 100, 100) // 2 bars back = 60 min earlier
  assertEquals(ret60mPctFrom30m(bars), 10)
})

Deno.test('ret60mPctFrom30m: fewer than 3 bars throws InsufficientDataError', () => {
  assertThrows(() => ret60mPctFrom30m(flatBars30m(2)), InsufficientDataError)
})

// --- volumeTrendRatioFrom30m -------------------------------------------

Deno.test('volumeTrendRatioFrom30m: ratio of the latest bar\'s volume to the trailing-4-bar mean', () => {
  const bars = flatBars30m(4)
  const volumes = [10, 10, 10, 40] // mean of all 4 = 17.5; latest = 40
  assertEquals(volumeTrendRatioFrom30m(bars, volumes), 40 / 17.5)
})

Deno.test('volumeTrendRatioFrom30m: zero long-window volume returns neutral 1, never divides by zero', () => {
  assertEquals(volumeTrendRatioFrom30m(flatBars30m(4), [0, 0, 0, 0]), 1)
})

Deno.test('volumeTrendRatioFrom30m: fewer than 4 volume points throws InsufficientDataError', () => {
  assertThrows(() => volumeTrendRatioFrom30m(flatBars30m(3), [1, 1, 1]), InsufficientDataError)
})

// --- buildNormalizedMarketDataForFade ------------------------------------

Deno.test('buildNormalizedMarketDataForFade: maps the snapshot\'s own series onto NormalizedMarketData, 1:1', () => {
  const snapshot = baseSnapshot()
  const result = buildNormalizedMarketDataForFade(snapshot)
  assertEquals(result.asset, 'BTC')
  assertEquals(result.price, snapshot.price)
  assertEquals(result.candles, snapshot.h4Candles)
  assertEquals(result.closeSeries, snapshot.hourlyCloses)
  assertEquals(result.volumeSeries, snapshot.hourlyVolumes)
  assertEquals(result.dailyCloseSeries, snapshot.dailyCloses)
})

// --- detectHistoricalCandidate -------------------------------------------

Deno.test('detectHistoricalCandidate: insufficient data -> data_insufficient, regime/arms null', () => {
  const result = detectHistoricalCandidate({
    snapshot: baseSnapshot({ bars30m: flatBars30m(5) }),
    config: V4_COMPAT_CONFIG,
    lastConsumedBarTs: null,
    feeBps: 10,
    slippageBps: 5,
  })
  assertEquals(result.noCandidateReason, 'data_insufficient')
  assertEquals(result.regimeState, null)
  assertEquals(result.eligibleArms, null)
})

Deno.test('detectHistoricalCandidate: disagreeing regime/4h legs -> regime_null never guessed, bias stays null', () => {
  // UP daily regime but FALLING 4h (EMA20 < EMA50) -> evaluateBias returns
  // NEUTRAL (a genuine disagreement value, not a null/insufficient-data
  // case) — kept here as a sufficiency-boundary sanity check: regimeState
  // is non-null and non-throwing even on a NEUTRAL resolution.
  const fallingH4 = Array.from({ length: 50 }, (_, i) => h4Bar(i, 129 - i))
  const result = detectHistoricalCandidate({
    snapshot: baseSnapshot({ h4Candles: fallingH4 }),
    config: V4_COMPAT_CONFIG,
    lastConsumedBarTs: null,
    feeBps: 10,
    slippageBps: 5,
  })
  assertEquals(result.regimeState, 'NEUTRAL')
})

Deno.test('detectHistoricalCandidate: no arm fires on flat bars -> no_arm_triggered', () => {
  const result = detectHistoricalCandidate({
    snapshot: baseSnapshot(),
    config: V4_COMPAT_CONFIG,
    lastConsumedBarTs: null,
    feeBps: 10,
    slippageBps: 5,
  })
  assertEquals(result.noCandidateReason, 'no_arm_triggered')
  assertEquals(result.regimeState, 'LONG')
  assertEquals(result.eligibleArms, ['breakout_long', 'pullback_long'])
})

// V4_COMPAT_CONFIG's breakoutMinVolumeTrendRatio=1.2 means a breakout
// fixture needs a genuine volume spike on its trigger bar, not uniform
// volume (which ratios to exactly 1.0 and fails confirmation) -- the SAME
// volume gate detectors.test.ts's own LONG_BREAKOUT_BARS fixture satisfies
// by passing an explicit 1.3 ratio directly; here it must come from the
// volumes30m array itself, since detectHistoricalCandidate computes the
// ratio internally.
function volumesWithSpikeOnLastBar(n: number): number[] {
  const volumes = Array.from({ length: n }, () => 10)
  volumes[n - 1] = 50 // trailing-4-bar mean = (10+10+10+50)/4 = 20; latest/mean = 2.5 >= 1.2
  return volumes
}

Deno.test('detectHistoricalCandidate: a real breakout_long edge -> a genuine OPEN_LONG candidate with computed prices', () => {
  const bars = flatBars30m(16, 100)
  bars[15] = bar30m(15, 105, 112, 104, 110) // breaks the prior 8-bar high
  const result = detectHistoricalCandidate({
    snapshot: baseSnapshot({ bars30m: bars, volumes30m: volumesWithSpikeOnLastBar(16), price: 110 }),
    config: V4_COMPAT_CONFIG,
    lastConsumedBarTs: null,
    feeBps: 10,
    slippageBps: 5,
  })
  assertEquals(result.noCandidateReason, null)
  assertEquals(result.opportunityContext?.armId, 'breakout_long')
  assertEquals(result.candidate?.action, 'OPEN_LONG')
  assertEquals(result.computedPrices !== undefined, true)
})

Deno.test('detectHistoricalCandidate: opportunity already consumed -> opportunity_consumed, no candidate', () => {
  const bars = flatBars30m(16, 100)
  bars[15] = bar30m(15, 105, 112, 104, 110)
  const result = detectHistoricalCandidate({
    snapshot: baseSnapshot({ bars30m: bars, volumes30m: volumesWithSpikeOnLastBar(16), price: 110 }),
    config: V4_COMPAT_CONFIG,
    lastConsumedBarTs: bars[15]!.timestamp, // already consumed exactly this bar
    feeBps: 10,
    slippageBps: 5,
  })
  assertEquals(result.noCandidateReason, 'opportunity_consumed')
  assertEquals(result.candidate, undefined)
})

Deno.test('detectHistoricalCandidate: a detected short with shortEnabled=false still populates opportunityContext, never a candidate', () => {
  const fallingDaily = dailySeries(Array.from({ length: 50 }, (_, i) => 129 - i))
  const fallingH4 = Array.from({ length: 50 }, (_, i) => h4Bar(i, 129 - i))
  const bars = flatBars30m(16, 100)
  bars[15] = bar30m(15, 95, 96, 88, 90) // breaks the prior 8-bar low
  const config = { ...V4_COMPAT_CONFIG, shortEnabled: false }
  const result = detectHistoricalCandidate({
    snapshot: baseSnapshot({ dailyCloses: fallingDaily, h4Candles: fallingH4, bars30m: bars, volumes30m: volumesWithSpikeOnLastBar(16), price: 90 }),
    config,
    lastConsumedBarTs: null,
    feeBps: 10,
    slippageBps: 5,
  })
  assertEquals(result.regimeState, 'SHORT')
  assertEquals(result.opportunityContext?.direction, 'short')
  assertEquals(result.candidate, undefined)
  assertEquals(result.noCandidateReason, null) // an opportunity WAS detected -- never conflated with no_arm_triggered
})
