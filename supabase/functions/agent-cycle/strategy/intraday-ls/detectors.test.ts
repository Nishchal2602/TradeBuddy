import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import {
  MIN_BARS_FOR_WINDOW_SCAN,
  detectBreakout,
  detectFadeOpportunity,
  detectIntradayLsOpportunity,
  detectPullback,
  isOpportunityStillValid,
  scanForEdge,
} from './detectors.ts'
import { testMomentumBreakout } from '../aggressive/detectors.ts'
import { InsufficientDataError } from '../../indicators/calculate.ts'
import type { OhlcCandle } from '../../../../../src/shared/market-data/types.ts'
import type { NormalizedMarketData } from '../../../../../src/shared/market-data/types.ts'

function bar(index: number, o: number, h: number, l: number, c: number): OhlcCandle {
  return { timestamp: new Date(Date.UTC(2026, 8, 23, 0, 0, 0) + index * 1_800_000).toISOString(), open: o, high: h, low: l, close: c }
}

function flatBars(n: number, price = 100): OhlcCandle[] {
  return Array.from({ length: n }, (_, i) => bar(i, price, price, price, price))
}

// --- scanForEdge ------------------------------------------------------

Deno.test('scanForEdge: fewer than MIN_BARS throws InsufficientDataError (the k=0 position itself is invalid)', () => {
  assertThrows(() => scanForEdge(flatBars(11), testMomentumBreakout), InsufficientDataError)
})

Deno.test('scanForEdge: an edge on the CURRENT bar (k=0) is found', () => {
  const bars = flatBars(16)
  bars[15] = bar(15, 105, 112, 104, 110) // breaks the prior 8-bar high (all 100)
  const result = scanForEdge(bars, testMomentumBreakout)
  assertEquals(result?.barIndex, 15)
  assertEquals(result?.barTs, bars[15]!.timestamp)
})

Deno.test('scanForEdge: an edge one bar back (k=1) is found when the current bar is no longer a fresh edge', () => {
  // bar14 breaks out fresh (its own prior-8-high, indices 6-13, is all 100).
  // bar15 continues at the new level: its own prior-8-high (indices 7-14)
  // now includes bar14's high=112, so bar15's close=110 does NOT exceed
  // it — k=0 is false, forcing the scan to k=1, which finds bar14's edge.
  const bars = flatBars(16)
  bars[14] = bar(14, 105, 112, 104, 110)
  bars[15] = bar(15, 110, 111, 109, 110)
  const result = scanForEdge(bars, testMomentumBreakout)
  assertEquals(result?.barIndex, 14)
  assertEquals(result?.barTs, bars[14]!.timestamp)
})

Deno.test('scanForEdge: an edge outside the WINDOW_SCAN_BARS=4 window (5+ bars back) is NOT found', () => {
  const bars = flatBars(16)
  bars[11] = bar(11, 105, 112, 104, 110) // an edge at its own time, but outside the 4 scanned positions (12-15)
  const result = scanForEdge(bars, testMomentumBreakout)
  assertEquals(result, null)
})

Deno.test('scanForEdge: of two genuinely separate edges within the window, the MOST RECENT (smallest k) wins', () => {
  const bars = flatBars(16)
  bars[12] = bar(12, 105, 112, 104, 110) // first edge
  bars[13] = bar(13, 100, 100, 100, 95) // reverts below the new high -> condition goes false again
  bars[14] = bar(14, 100, 100, 100, 95)
  bars[15] = bar(15, 110, 125, 108, 120) // second, independent, more recent edge
  const result = scanForEdge(bars, testMomentumBreakout)
  assertEquals(result?.barIndex, 15) // the newer edge, not the older one at index 12
})

Deno.test('scanForEdge: exactly MIN_BARS_FOR_WINDOW_SCAN bars supports all 4 scan positions without throwing', () => {
  const bars = flatBars(MIN_BARS_FOR_WINDOW_SCAN)
  assertEquals(scanForEdge(bars, testMomentumBreakout), null) // flat series, no edge anywhere — just proving no throw
})

Deno.test('scanForEdge: fewer bars than all 4 positions need degrades gracefully (checks what it can, never throws)', () => {
  const bars = flatBars(12) // exactly MIN_BARS — only k=0 is evaluable
  assertEquals(scanForEdge(bars, testMomentumBreakout), null)
})

// --- detectBreakout (direction + confirmation) -----------------------

const LONG_BREAKOUT_BARS = (() => {
  const bars = flatBars(16)
  bars[15] = bar(15, 105, 112, 104, 110)
  return bars
})()

const SHORT_BREAKDOWN_BARS = (() => {
  const bars = flatBars(16)
  bars[15] = bar(15, 95, 96, 88, 90) // closes below the prior 8-bar low (all 100)
  return bars
})()

Deno.test('detectBreakout: long, confirmed (volumeTrendRatio>=1.2, ret60mPct>0) -> breakout_long', () => {
  const result = detectBreakout('long', LONG_BREAKOUT_BARS, { ret60mPct: 1.5, volumeTrendRatio: 1.3 })
  assertEquals(result, { armId: 'breakout_long', direction: 'long', detectedAtBarTs: LONG_BREAKOUT_BARS[15]!.timestamp })
})

Deno.test('detectBreakout: long, edge fires but volumeTrendRatio below 1.2 -> null', () => {
  assertEquals(detectBreakout('long', LONG_BREAKOUT_BARS, { ret60mPct: 1.5, volumeTrendRatio: 1.19 }), null)
})

Deno.test('detectBreakout: long, edge fires but ret60mPct is negative (direction mismatch) -> null', () => {
  assertEquals(detectBreakout('long', LONG_BREAKOUT_BARS, { ret60mPct: -0.5, volumeTrendRatio: 1.3 }), null)
})

Deno.test('detectBreakout: short, mirrored via invertBars, confirmed (ret60mPct<0) -> breakout_short', () => {
  const result = detectBreakout('short', SHORT_BREAKDOWN_BARS, { ret60mPct: -1.2, volumeTrendRatio: 1.5 })
  assertEquals(result, { armId: 'breakout_short', direction: 'short', detectedAtBarTs: SHORT_BREAKDOWN_BARS[15]!.timestamp })
})

Deno.test('detectBreakout: short, but ret60mPct is positive (direction mismatch) -> null', () => {
  assertEquals(detectBreakout('short', SHORT_BREAKDOWN_BARS, { ret60mPct: 0.5, volumeTrendRatio: 1.5 }), null)
})

Deno.test('detectBreakout: no edge at all -> null regardless of confirmation', () => {
  assertEquals(detectBreakout('long', flatBars(16), { ret60mPct: 5, volumeTrendRatio: 5 }), null)
})

// --- detectPullback (direction, no separate confirmation) -------------

// 12 bars (indices 0-11) — scanForEdge's hard MIN_BARS=12 floor, unlike
// the 9-bar fixtures mirror.test.ts uses directly against
// testPullbackContinuation (which has no such floor of its own).
// Structure shifted +3 from that same derivation: H=120 at index8,
// postH leg starts at index9 (low=100), current (index11) closes green
// at 116, mid=110 — worked the same way, just at a higher absolute
// index so n-1-RECENCY_BARS(12-1-4=7) <= hAbsoluteIdx(8) still passes.
function pullbackLongBars(): OhlcCandle[] {
  const bars = flatBars(12)
  bars[8] = bar(8, 100, 120, 98, 115) // H = 120
  bars[9] = bar(9, 110, 111, 100, 101) // start of the retracement leg, low=100
  bars[11] = bar(11, 105, 118, 104, 116) // current: green, between mid(110) and H(120)
  return bars
}

Deno.test('detectPullback: long — a known pullback-continuation shape fires pullback_long', () => {
  const bars = pullbackLongBars()
  const result = detectPullback('long', bars)
  assertEquals(result, { armId: 'pullback_long', direction: 'long', detectedAtBarTs: bars[11]!.timestamp })
})

Deno.test('detectPullback: short — the SAME shape mirrored (invertBars) fires pullback_short on the real (un-mirrored) candles', () => {
  // realBars is what a genuine downtrend-pullback-resuming-down looks
  // like on an un-mirrored chart: invertBars(a known-good long shape).
  // detectPullback('short', realBars) re-inverts internally, recovering
  // the known-good shape exactly (mirror.test.ts proves this round-trip).
  const invert = (bars: OhlcCandle[]): OhlcCandle[] => bars.map((b) => ({ timestamp: b.timestamp, open: -b.open, high: -b.low, low: -b.high, close: -b.close }))
  const realBars = invert(pullbackLongBars())
  const result = detectPullback('short', realBars)
  assertEquals(result?.armId, 'pullback_short')
  assertEquals(result?.direction, 'short')
  assertEquals(result?.detectedAtBarTs, realBars[11]!.timestamp)
})

Deno.test('detectPullback: no pullback shape present -> null', () => {
  assertEquals(detectPullback('long', flatBars(12)), null)
})

// --- detectFadeOpportunity (NEUTRAL-only, hourly-RSI + 4h-ATR/range) ---

function fadeMarketData(closes: number[]): NormalizedMarketData {
  const DAY = 86_400_000
  const closeSeries = closes.map((close, i) => ({ timestamp: new Date(1759276800000 + i * DAY).toISOString(), close }))
  const candles: OhlcCandle[] = closes.map((c, i) => {
    const prev = i > 0 ? closes[i - 1]! : c
    return { timestamp: closeSeries[i]!.timestamp, open: prev, high: Math.max(prev, c) + 0.5, low: Math.min(prev, c) - 0.5, close: c }
  })
  return {
    asset: 'BTC', provider: 'coingecko', dataAsOf: closeSeries.at(-1)!.timestamp, fetchedAt: closeSeries.at(-1)!.timestamp,
    price: closes.at(-1)!, change1hPct: null, change24hPct: null, change7dPct: null,
    candles, closeSeries, volumeSeries: [], dailyCloseSeries: [],
  } as unknown as NormalizedMarketData
}

// Verified numerically (RSI/ATR%/7-day-range computed directly against
// the real indicator functions, not hand-derived) before being frozen
// here: RSI(14) full=23.58 (<=30, oversold), RSI(14) one-point-prior=35.00
// (NOT yet oversold) -> a genuine edge at the last point, not a sustained
// condition. distanceFromLowPct(0.59) well inside 1x ATR%(3.39).
const FADE_LONG_CLOSES = [100, 101, 100, 101, 99, 100, 98, 99, 97, 98, 96, 97, 95, 96, 94, 85]

// Mirror-image construction for overbought: RSI(14) full=76.42 (>=70),
// prior=65.00 (not yet overbought). distanceFromHighPct(-0.43) within 1x
// ATR%(2.51) of the 7-day high.
const FADE_SHORT_CLOSES = [100, 99, 100, 99, 101, 100, 102, 101, 103, 102, 104, 103, 105, 104, 106, 115]

Deno.test('detectFadeOpportunity: NEUTRAL bias, oversold RSI crossing + near 7-day low -> fade_long', () => {
  const result = detectFadeOpportunity('NEUTRAL', fadeMarketData(FADE_LONG_CLOSES))
  assertEquals(result?.armId, 'fade_long')
  assertEquals(result?.direction, 'long')
})

Deno.test('detectFadeOpportunity: NEUTRAL bias, overbought RSI crossing + near 7-day high -> fade_short', () => {
  const result = detectFadeOpportunity('NEUTRAL', fadeMarketData(FADE_SHORT_CLOSES))
  assertEquals(result?.armId, 'fade_short')
  assertEquals(result?.direction, 'short')
})

Deno.test('detectFadeOpportunity: LONG bias -> null even with an oversold shape (fades are NEUTRAL-only)', () => {
  assertEquals(detectFadeOpportunity('LONG', fadeMarketData(FADE_LONG_CLOSES)), null)
})

Deno.test('detectFadeOpportunity: SHORT bias -> null even with an overbought shape (fades are NEUTRAL-only)', () => {
  assertEquals(detectFadeOpportunity('SHORT', fadeMarketData(FADE_SHORT_CLOSES)), null)
})

Deno.test('detectFadeOpportunity: sustained oversold (prior ALSO already <=30) does not re-fire — edge-triggered, not a state check', () => {
  // Verified numerically: a steady decline into, and staying within, the
  // oversold zone gives RSI(14)=0.00 for BOTH the full and one-point-prior
  // series — fadeLongCondition is true at both, so this is a CONTINUING
  // condition, not a fresh crossing, and must not fire (the same
  // discipline aggressive/detectors.ts's own "does not re-fire on the
  // next bar" tests prove for breakout/pullback).
  const closes = [100, 98, 96, 94, 92, 90, 88, 86, 85, 84, 83, 82, 81, 80, 79, 78]
  assertEquals(detectFadeOpportunity('NEUTRAL', fadeMarketData(closes)), null)
})

Deno.test('detectFadeOpportunity: fewer than 16 closes or candles -> null (fails closed, same discipline as every other data-sufficiency gate)', () => {
  const short = fadeMarketData(FADE_LONG_CLOSES.slice(1)) // 15 points
  assertEquals(detectFadeOpportunity('NEUTRAL', short), null)
})

// --- detectIntradayLsOpportunity (combined: bias-gated priority) -------

Deno.test('detectIntradayLsOpportunity: LONG bias, breakout confirmed -> breakout_long (fade never attempted)', () => {
  const result = detectIntradayLsOpportunity('LONG', LONG_BREAKOUT_BARS, { ret60mPct: 1, volumeTrendRatio: 1.5 }, fadeMarketData(FADE_LONG_CLOSES))
  assertEquals(result?.armId, 'breakout_long')
})

Deno.test('detectIntradayLsOpportunity: LONG bias, breakout fails confirmation, pullback fires -> pullback_long (priority: breakout checked first, falls through)', () => {
  // No breakout shape present in pullbackLongBars() at all (it never
  // exceeds its own prior-8 high beyond the pullback shape itself), so
  // breakout legitimately finds nothing and detection falls through.
  const pullbackBars = pullbackLongBars()
  const result = detectIntradayLsOpportunity('LONG', pullbackBars, { ret60mPct: 1, volumeTrendRatio: 1.5 }, fadeMarketData(FADE_LONG_CLOSES))
  assertEquals(result?.armId, 'pullback_long')
})

Deno.test('detectIntradayLsOpportunity: NEUTRAL bias attempts ONLY fade — breakout/pullback-shaped bars are ignored', () => {
  const result = detectIntradayLsOpportunity('NEUTRAL', LONG_BREAKOUT_BARS, { ret60mPct: 1, volumeTrendRatio: 1.5 }, fadeMarketData(FADE_LONG_CLOSES))
  assertEquals(result?.armId, 'fade_long') // not breakout_long, even though LONG_BREAKOUT_BARS would fire under LONG/SHORT bias
})

Deno.test('detectIntradayLsOpportunity: nothing fires under any bias -> null', () => {
  assertEquals(detectIntradayLsOpportunity('LONG', flatBars(16), { ret60mPct: 1, volumeTrendRatio: 1.5 }, fadeMarketData(FADE_LONG_CLOSES.map(() => 100))), null)
})

// --- isOpportunityStillValid (signal-validity drift check) ------------

Deno.test('isOpportunityStillValid: price unchanged since the trigger bar -> valid', () => {
  assertEquals(isOpportunityStillValid(100, 100, 0.012), true)
})

Deno.test('isOpportunityStillValid: drift exactly half the stop distance -> valid (boundary inclusive)', () => {
  // half of 1.2% = 0.6%; price moved exactly 0.6% from the trigger close.
  assertEquals(isOpportunityStillValid(100, 100.6, 0.012), true)
})

Deno.test('isOpportunityStillValid: drift beyond half the stop distance -> invalid', () => {
  assertEquals(isOpportunityStillValid(100, 100.61, 0.012), false)
})

Deno.test('isOpportunityStillValid: drift is direction-agnostic (works the same for a move down)', () => {
  assertEquals(isOpportunityStillValid(100, 99.4, 0.012), true) // exactly -0.6%
  assertEquals(isOpportunityStillValid(100, 99.39, 0.012), false)
})
