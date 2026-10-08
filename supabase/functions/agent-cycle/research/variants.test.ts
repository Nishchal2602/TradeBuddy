import { assertEquals } from 'jsr:@std/assert@1'
import { buildRandomEntryDetector, computeIntradayLsProtectionFromConfig, resolveDailyOnlyBias } from './variants.ts'
import { V4_COMPAT_CONFIG } from '../../../../src/shared/strategy/config-presets.ts'
import type { HistoricalMarketSnapshot } from './historical-detect.ts'
import type { OhlcCandle } from '../../../../src/shared/market-data/types.ts'

const DAY = 86_400_000
const HALF_HOUR = 1_800_000

function dailySeries(closes: number[], endIso = '2026-09-21T00:00:00.000Z'): { timestamp: string; close: number }[] {
  const end = new Date(endIso).getTime()
  return closes.map((close, i) => ({ timestamp: new Date(end - (closes.length - 1 - i) * DAY).toISOString(), close }))
}

// --- resolveDailyOnlyBias ---------------------------------------------

Deno.test('resolveDailyOnlyBias: UP daily regime -> LONG, regardless of the (ignored) 4h series', () => {
  const up = dailySeries(Array.from({ length: 50 }, (_, i) => 80 + i))
  assertEquals(resolveDailyOnlyBias(up, [999, 1, 500]), 'LONG')
})

Deno.test('resolveDailyOnlyBias: DOWN daily regime -> SHORT, never NEUTRAL (no NEUTRAL state exists in this variant)', () => {
  const down = dailySeries(Array.from({ length: 50 }, (_, i) => 129 - i))
  assertEquals(resolveDailyOnlyBias(down, []), 'SHORT')
})

Deno.test('resolveDailyOnlyBias: fewer than 50 daily closes fails closed (null)', () => {
  const short = dailySeries(Array.from({ length: 49 }, () => 100))
  assertEquals(resolveDailyOnlyBias(short, []), null)
})

// --- computeIntradayLsProtectionFromConfig ---------------------------

Deno.test('computeIntradayLsProtectionFromConfig: reproduces the live formula exactly when fed V4_COMPAT_CONFIG\'s own values', () => {
  const protect = computeIntradayLsProtectionFromConfig(V4_COMPAT_CONFIG)
  const result = protect('breakout_long', 0.6) // atrFraction = 0.006 -> 2.0x = 0.012, equals the 0.012 floor exactly
  assertEquals(result.stopLossPct, 0.012)
  assertEquals(result.takeProfitPct, 0.012 * 2.0)
})

Deno.test('computeIntradayLsProtectionFromConfig: a fade arm uses ITS OWN configured reward:risk, not the trend-arm default', () => {
  const protect = computeIntradayLsProtectionFromConfig(V4_COMPAT_CONFIG)
  const result = protect('fade_long', 0.6)
  assertEquals(result.stopLossPct, 0.012)
  assertEquals(result.takeProfitPct, 0.012 * 1.5)
})

Deno.test('computeIntradayLsProtectionFromConfig: an alternative config (different multiple/floor) produces genuinely different geometry', () => {
  const widerConfig = { ...V4_COMPAT_CONFIG, stopAtrMultiple: 3.0, stopFloorPct: 0.02 }
  const protect = computeIntradayLsProtectionFromConfig(widerConfig)
  const result = protect('breakout_long', 0.6) // atrFraction = 0.006 -> 3.0x = 0.018, below the 0.02 floor -> floor binds
  assertEquals(result.stopLossPct, 0.02)
})

// --- buildRandomEntryDetector ------------------------------------------

function bar30m(i: number, price: number): OhlcCandle {
  return { timestamp: new Date(Date.UTC(2026, 8, 23, 0, 0, 0) + i * HALF_HOUR).toISOString(), open: price, high: price, low: price, close: price }
}

function sufficientSnapshot(): HistoricalMarketSnapshot {
  const daily = dailySeries(Array.from({ length: 50 }, (_, i) => 80 + i))
  const h4 = Array.from({ length: 50 }, (_, i) => ({ timestamp: daily[i]!.timestamp, open: 80 + i, high: 80 + i, low: 80 + i, close: 80 + i }))
  const bars = Array.from({ length: 16 }, (_, i) => bar30m(i, 100))
  return {
    asset: 'BTC',
    dailyCloses: daily,
    h4Candles: h4,
    hourlyCloses: [],
    hourlyVolumes: [],
    bars30m: bars,
    volumes30m: bars.map(() => 10),
    price: 100,
    asOfIso: bars[bars.length - 1]!.timestamp,
  }
}

Deno.test('buildRandomEntryDetector: produces an unconditional candidate every time, with no bias/arm concept', () => {
  const detect = buildRandomEntryDetector('long', true)
  const result = detect({ snapshot: sufficientSnapshot(), config: V4_COMPAT_CONFIG, lastConsumedBarTs: null, feeBps: 10, slippageBps: 5 })
  assertEquals(result.candidate?.action, 'OPEN_LONG')
  assertEquals(result.regimeState, null)
  assertEquals(result.eligibleArms, null)
  assertEquals(result.noCandidateReason, null)
})

Deno.test('buildRandomEntryDetector: insufficient data -> data_insufficient, same floor as the real detector', () => {
  const detect = buildRandomEntryDetector('long', true)
  const snapshot = { ...sufficientSnapshot(), bars30m: sufficientSnapshot().bars30m.slice(0, 5) }
  const result = detect({ snapshot, config: V4_COMPAT_CONFIG, lastConsumedBarTs: null, feeBps: 10, slippageBps: 5 })
  assertEquals(result.noCandidateReason, 'data_insufficient')
})

Deno.test('buildRandomEntryDetector: a short baseline with shortEnabled=false is measurable (no error) but never produces a candidate', () => {
  const detect = buildRandomEntryDetector('short', false)
  const result = detect({ snapshot: sufficientSnapshot(), config: V4_COMPAT_CONFIG, lastConsumedBarTs: null, feeBps: 10, slippageBps: 5 })
  assertEquals(result.candidate, undefined)
  assertEquals(result.noCandidateReason, null)
})

Deno.test('buildRandomEntryDetector: repeated calls on the identical snapshot always produce the identical candidate -- no hidden state, no real randomness', () => {
  const detect = buildRandomEntryDetector('long', true)
  const snapshot = sufficientSnapshot()
  const first = detect({ snapshot, config: V4_COMPAT_CONFIG, lastConsumedBarTs: null, feeBps: 10, slippageBps: 5 })
  const second = detect({ snapshot, config: V4_COMPAT_CONFIG, lastConsumedBarTs: null, feeBps: 10, slippageBps: 5 })
  assertEquals(first, second)
})
