import type { OhlcCandle } from '../../../../../src/shared/market-data/types.ts'

// Strategy V4 (intraday_ls, 2026-10-01) — turns a LONG detector into its
// exact SHORT mirror by negating prices. A breakout on inverted bars is a
// breakdown on the real ones; a pullback-continuation's close>open
// (green-candle) requirement inverts to close<open (red candle), exactly
// the right confirmation for a downtrend pullback resuming down.
//
// This only works for detectors built from LINEAR comparisons — highs,
// lows, midpoints, open/close ordering — exactly what
// aggressive/detectors.ts's testMomentumBreakout/testPullbackContinuation
// are (both reused directly here, not reimplemented). Anything using a
// RATIO or PERCENTAGE breaks under negative prices: fade's RSI/ATR%-based
// conditions are never mirrored this way — see detectors.ts, where fade
// is written directly against real (non-inverted) prices instead.
//
// Timestamps are passed through unchanged — inversion only negates the
// four price fields, so an inverted bar's index still corresponds to the
// same real-world timestamp as the original, letting callers read
// detectedAtBarTs off either array interchangeably.
export function invertBars(bars: readonly OhlcCandle[]): OhlcCandle[] {
  return bars.map((b) => ({
    timestamp: b.timestamp,
    open: -b.open,
    high: -b.low,
    low: -b.high,
    close: -b.close,
  }))
}
