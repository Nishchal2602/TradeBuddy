import { assertEquals } from 'jsr:@std/assert@1'
import { detectCandidate } from './detect-candidate.ts'
import type { NormalizedMarketData, OhlcCandle } from '../../../../../src/shared/market-data/types.ts'
import type { IntradayMarketData } from '../aggressive/types.ts'
import type { IntradayLsConfig } from '../../../../../src/shared/strategy/config-schema.ts'
import { V4_COMPAT_CONFIG, V4_1_CORRECTED_CONFIG } from '../../../../../src/shared/strategy/config-presets.ts'

// CFG-1 Stage 2 (2026-10-06) — composition/wiring tests for the extracted
// detectCandidate: one fixture per reachable branch point, reusing the
// SAME combinations detectors.test.ts/bias.test.ts/registry.test.ts have
// already individually proven work (breakout under LONG bias with
// volume confirmation disabled, matching v4.1-corrected's own correction
// #9 — the simplest reliable "a real edge fires" fixture available).
// This file is NOT re-proving arm-detection/bias/sufficiency correctness
// — each of those already has its own exhaustive test file. Its only job
// is: does the composed function route to the right branch, in the
// right order, with the right data threaded through.

const DAY = 86_400_000
const FOUR_H = 14_400_000
const THIRTY_M = 1_800_000
const FIVE_M = 300_000

function dailySeries(closes: number[], endIso: string): { timestamp: string; close: number }[] {
  const end = new Date(endIso).getTime()
  return closes.map((close, i) => ({ timestamp: new Date(end - (closes.length - 1 - i) * DAY).toISOString(), close }))
}

function h4Candles(closes: number[], endIso: string): OhlcCandle[] {
  const end = new Date(endIso).getTime()
  return closes.map((close, i) => ({
    timestamp: new Date(end - (closes.length - 1 - i) * FOUR_H).toISOString(),
    open: close - 0.5, high: close + 1, low: close - 1, close,
  }))
}

function bar30m(index: number, o: number, h: number, l: number, c: number, endIso: string, total: number): OhlcCandle {
  const end = new Date(endIso).getTime()
  return { timestamp: new Date(end - (total - 1 - index) * THIRTY_M).toISOString(), open: o, high: h, low: l, close: c }
}

function flat30m(n: number, price: number, endIso: string): OhlcCandle[] {
  return Array.from({ length: n }, (_, i) => bar30m(i, price, price, price, price, endIso, n))
}

function monotonicSpot5m(n: number, start: number, step: number, endIso: string, volume = 10) {
  const end = new Date(endIso).getTime()
  return Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(end - (n - 1 - i) * FIVE_M).toISOString(),
    price: start + i * step,
    volume,
  }))
}

// volumeTrend() = mean(last 6) / mean(last 24). A flat volume=10 series
// (every other fixture in this file) gives exactly 1.0 — below V4_COMPAT_
// CONFIG's own 1.2 confirmation floor, which that config (unlike
// v4.1-corrected) still enforces. Only the one test that deliberately
// exercises v4-compat's breakout path needs this elevated-tail variant.
function volumeConfirmedSpot5m(n: number, start: number, step: number, endIso: string) {
  const points = monotonicSpot5m(n, start, step, endIso, 10)
  for (let i = points.length - 6; i < points.length; i++) points[i]!.volume = 20 // ratio = 20/12.5 = 1.6
  return points
}

const NOW_ISO = '2026-10-06T12:00:00.000Z'

// 50 ascending daily closes (regime UP) + 50 ascending 4h closes (h4Up) -> LONG.
const UP_DAILY = dailySeries(Array.from({ length: 50 }, (_, i) => 80 + i), NOW_ISO)
const RISING_H4 = h4Candles(Array.from({ length: 50 }, (_, i) => 80 + i), NOW_ISO)
// 50 descending daily closes (regime DOWN) + 50 descending 4h closes (!h4Up) -> SHORT.
const DOWN_DAILY = dailySeries(Array.from({ length: 50 }, (_, i) => 129 - i), NOW_ISO)
const FALLING_H4 = h4Candles(Array.from({ length: 50 }, (_, i) => 129 - i), NOW_ISO)

// A LONG breakout: 15 flat 100-bars, then a close (110) above the prior
// 8-bar high — the identical shape detectors.test.ts's LONG_BREAKOUT_BARS
// uses, rebuilt locally rather than imported across test files.
const LONG_BREAKOUT_30M = [...flat30m(15, 100, NOW_ISO), bar30m(15, 105, 112, 104, 110, NOW_ISO, 16)]
const LONG_BREAKOUT_BAR_TS = LONG_BREAKOUT_30M[15]!.timestamp

// Mirrored SHORT breakdown: a close (90) below the prior 8-bar low.
const SHORT_BREAKDOWN_30M = [...flat30m(15, 100, NOW_ISO), bar30m(15, 95, 96, 88, 90, NOW_ISO, 16)]
const SHORT_BREAKDOWN_BAR_TS = SHORT_BREAKDOWN_30M[15]!.timestamp

function baseMarketData(overrides: Partial<NormalizedMarketData> = {}): NormalizedMarketData {
  return {
    asset: 'BTC',
    provider: 'coingecko',
    dataAsOf: NOW_ISO,
    fetchedAt: NOW_ISO,
    price: 110,
    change1hPct: null,
    change24hPct: null,
    change7dPct: null,
    candles: RISING_H4,
    closeSeries: RISING_H4.map((c) => ({ timestamp: c.timestamp, close: c.close })),
    volumeSeries: RISING_H4.map((c) => ({ timestamp: c.timestamp, volume: 1000 })),
    dailyCloseSeries: UP_DAILY,
    ...overrides,
  }
}

function baseIntraday(overrides: Partial<IntradayMarketData> = {}): IntradayMarketData {
  return {
    asset: 'BTC',
    ohlc30m: LONG_BREAKOUT_30M,
    spot5m: monotonicSpot5m(30, 100, 0.2, NOW_ISO), // rising -> ret60mPct > 0
    ...overrides,
  }
}

// v4.1-corrected already ships breakoutMinVolumeTrendRatio: null (Stage 1B
// correction #9) — reused as the base config for every "a real edge fires"
// fixture below, since it's the simplest reliable way to isolate the
// direction confirmation (ret60mPct's sign) from volume, which a hand-built
// spot5m series would otherwise have to satisfy arbitrarily too.
const BASE_CONFIG: IntradayLsConfig = V4_1_CORRECTED_CONFIG

Deno.test('detectCandidate: insufficient data -> data_insufficient, nothing else populated', () => {
  const result = detectCandidate({
    assetMarketData: baseMarketData(),
    intraday: baseIntraday({ ohlc30m: LONG_BREAKOUT_30M.slice(0, 5) }), // < MIN_BARS
    config: BASE_CONFIG,
    lastConsumedBarTs: null,
    feeBps: 10,
    slippageBps: 5,
  })
  assertEquals(result.noCandidateReason, 'data_insufficient')
  assertEquals(result.regimeState, undefined)
  assertEquals(result.candidate, undefined)
})

Deno.test('detectCandidate: no intraday data at all -> data_insufficient', () => {
  const result = detectCandidate({
    assetMarketData: baseMarketData(),
    intraday: undefined,
    config: BASE_CONFIG,
    lastConsumedBarTs: null,
    feeBps: 10,
    slippageBps: 5,
  })
  assertEquals(result.noCandidateReason, 'data_insufficient')
})

// regime_null is intentionally NOT tested here: evaluateBias's own null
// conditions (dailyCloses.length < 50, h4Closes.length < 50) are exactly
// checkStrategyDataSufficiency's own 'intraday_ls' floors (same constants,
// same comparison) — so once sufficiency passes, evaluateBias structurally
// cannot return null. This branch is unreachable through this composed
// function today, same class of finding as 'arm_disabled'/
// 'direction_disabled' being valid DB values this code never assigns.
// bias.test.ts already covers evaluateBias's own null path directly.

Deno.test('detectCandidate: sufficient data, valid bias, but no arm shape present -> no_arm_triggered', () => {
  const result = detectCandidate({
    assetMarketData: baseMarketData(),
    intraday: baseIntraday({ ohlc30m: flat30m(16, 100, NOW_ISO), spot5m: monotonicSpot5m(30, 100, 0, NOW_ISO) }),
    config: BASE_CONFIG,
    lastConsumedBarTs: null,
    feeBps: 10,
    slippageBps: 5,
  })
  assertEquals(result.regimeState, 'LONG')
  assertEquals(result.noCandidateReason, 'no_arm_triggered')
  assertEquals(result.eligibleArms, BASE_CONFIG.directionPolicy.LONG)
})

Deno.test('detectCandidate: an arm fires but round-trip cost swamps the stop -> cost_gate', () => {
  const result = detectCandidate({
    assetMarketData: baseMarketData(),
    intraday: baseIntraday(),
    config: BASE_CONFIG,
    lastConsumedBarTs: null,
    feeBps: 500, // deliberately enormous — guarantees the 0.25 cost-gate ratio fails regardless of the resolved stop%
    slippageBps: 500,
  })
  assertEquals(result.noCandidateReason, 'cost_gate')
  assertEquals(result.candidate, undefined)
})

Deno.test('detectCandidate: a real edge already consumed by a prior decision -> opportunity_consumed, not re-emitted', () => {
  const result = detectCandidate({
    assetMarketData: baseMarketData(),
    intraday: baseIntraday(),
    config: BASE_CONFIG,
    lastConsumedBarTs: LONG_BREAKOUT_BAR_TS, // >= the trigger bar itself
    feeBps: 10,
    slippageBps: 5,
  })
  assertEquals(result.noCandidateReason, 'opportunity_consumed')
})

Deno.test('detectCandidate: signalDriftRuleEnforced + price has drifted past the fraction -> signal_stale, opportunity NOT consumed', () => {
  const result = detectCandidate({
    assetMarketData: baseMarketData({ price: 500 }), // wildly far from the trigger bar's own close (110)
    intraday: baseIntraday(),
    config: { ...V4_1_CORRECTED_CONFIG, signalDriftRuleEnforced: true },
    lastConsumedBarTs: null,
    feeBps: 10,
    slippageBps: 5,
  })
  assertEquals(result.noCandidateReason, 'signal_stale')
  assertEquals(result.opportunityContext, undefined, 'a stale signal must not be consumed — no opportunity_bar_ts write')
  assertEquals(result.candidate, undefined)
})

Deno.test('detectCandidate: v4-compat never applies the drift check at all (signalDriftRuleEnforced: false) — a huge drift still reaches a real candidate', () => {
  const result = detectCandidate({
    assetMarketData: baseMarketData({ price: 500 }),
    // v4-compat (unlike BASE_CONFIG/v4.1-corrected) still enforces the
    // 1.2 volume-trend confirmation (Stage 1B correction #9 is what
    // removed it) — this fixture's spot5m must actually clear that
    // floor, or the breakout never fires and the test proves nothing.
    intraday: baseIntraday({ spot5m: volumeConfirmedSpot5m(30, 100, 0.2, NOW_ISO) }),
    config: V4_COMPAT_CONFIG,
    lastConsumedBarTs: null,
    feeBps: 10,
    slippageBps: 5,
  })
  assertEquals(result.noCandidateReason, undefined, "undefined, not null — matches the original inlined code's own never-assigned-on-this-path value; index.ts's own insert site is what later coalesces this to null via '?? null'")
  assertEquals(result.candidate?.action, 'OPEN_LONG')
})

Deno.test('detectCandidate: the full happy path — LONG bias, a real breakout, clears every gate -> a genuine OPEN_LONG candidate', () => {
  const result = detectCandidate({
    assetMarketData: baseMarketData(),
    intraday: baseIntraday(),
    config: BASE_CONFIG,
    lastConsumedBarTs: null,
    feeBps: 10,
    slippageBps: 5,
  })
  assertEquals(result.noCandidateReason, undefined)
  assertEquals(result.regimeState, 'LONG')
  assertEquals(result.opportunityContext?.armId, 'breakout_long')
  assertEquals(result.opportunityContext?.direction, 'long')
  assertEquals(result.opportunityContext?.opportunityBarTs, LONG_BREAKOUT_BAR_TS)
  assertEquals(result.candidate?.asset, 'BTC')
  assertEquals(result.candidate?.action, 'OPEN_LONG')
  assertEquals(result.candidate?.confidence, 1)
  assertEquals(result.computedPrices !== undefined, true)
})

Deno.test('detectCandidate: SHORT reachable but disabled — opportunityContext is set (arm_id/bias persist), candidate stays unset, no_candidate_reason stays null', () => {
  const result = detectCandidate({
    assetMarketData: baseMarketData({ price: 90, candles: FALLING_H4, dailyCloseSeries: DOWN_DAILY, closeSeries: FALLING_H4.map((c) => ({ timestamp: c.timestamp, close: c.close })) }),
    intraday: baseIntraday({ ohlc30m: SHORT_BREAKDOWN_30M, spot5m: monotonicSpot5m(30, 100, -0.2, NOW_ISO) }),
    config: { ...V4_1_CORRECTED_CONFIG, shortEnabled: false },
    lastConsumedBarTs: null,
    feeBps: 10,
    slippageBps: 5,
  })
  assertEquals(result.regimeState, 'SHORT')
  assertEquals(result.noCandidateReason, undefined, "an opportunity WAS detected — this field means 'no opportunity', not 'no trade' (undefined here, coalesced to null only at index.ts's own insert site)")
  assertEquals(result.opportunityContext?.armId, 'breakout_short')
  assertEquals(result.opportunityContext?.opportunityBarTs, SHORT_BREAKDOWN_BAR_TS)
  assertEquals(result.candidate, undefined, 'shortEnabled=false must suppress the trade proposal, not the opportunity record')
})

Deno.test('detectCandidate: the same SHORT edge DOES reach a candidate once shortEnabled is true', () => {
  const result = detectCandidate({
    assetMarketData: baseMarketData({ price: 90, candles: FALLING_H4, dailyCloseSeries: DOWN_DAILY, closeSeries: FALLING_H4.map((c) => ({ timestamp: c.timestamp, close: c.close })) }),
    intraday: baseIntraday({ ohlc30m: SHORT_BREAKDOWN_30M, spot5m: monotonicSpot5m(30, 100, -0.2, NOW_ISO) }),
    config: { ...V4_1_CORRECTED_CONFIG, shortEnabled: true },
    lastConsumedBarTs: null,
    feeBps: 10,
    slippageBps: 5,
  })
  assertEquals(result.candidate?.action, 'OPEN_SHORT')
})
