import { evaluateTrendRegime } from '../regime.ts'
import { calculateEMA } from '../../indicators/calculate.ts'
import { TREND_MA_LOOKBACK_DAYS } from '../../../../../src/shared/strategy/types.ts'

// Strategy V4 (intraday_ls, 2026-10-01) — the per-cycle directional bias
// every one of the six detector arms is gated by (Strategy V4 plan §3.1).
// Reuses evaluateTrendRegime (the SAME daily 50-day SMA rule Balanced's
// own entry logic uses, unmodified) and adds a 4-hour EMA20/EMA50 cross.
// Both legs must agree for a directional bias; disagreement is NEUTRAL,
// never a guess, and either leg missing enough history fails the whole
// bias closed (null) — matching this codebase's existing fail-closed
// discipline for every other data-sufficiency gate.
export type Bias = 'LONG' | 'SHORT' | 'NEUTRAL'

const H4_EMA_FAST_PERIOD = 20
const H4_EMA_SLOW_PERIOD = 50
// The EMA50 leg's own floor — exported so registry.ts's data-sufficiency
// check (checkStrategyDataSufficiency) can enforce it up front, rather
// than let evaluateBias's own null-return be the only signal.
export const MIN_H4_CLOSES = H4_EMA_SLOW_PERIOD

// h4Closes must be oldest -> newest, true-OHLC-derived closes — in
// practice NormalizedMarketData.candles.map(c => c.close), the SAME
// 4-hourly series already fetched every cycle for Balanced's ATR% (zero
// extra cost — verified live: 180 bars at exactly 4h spacing, Phase 0's
// own finding).
export function evaluateBias(dailyCloses: readonly { timestamp: string; close: number }[], h4Closes: readonly number[]): Bias | null {
  if (dailyCloses.length < TREND_MA_LOOKBACK_DAYS) return null // same floor regimeContextFor already enforces
  if (h4Closes.length < MIN_H4_CLOSES) return null

  const regime = evaluateTrendRegime(dailyCloses)
  const mutableH4Closes = [...h4Closes]
  const h4Up = calculateEMA(mutableH4Closes, H4_EMA_FAST_PERIOD) > calculateEMA(mutableH4Closes, H4_EMA_SLOW_PERIOD)

  if (regime.regime === 'UP' && h4Up) return 'LONG'
  if (regime.regime === 'DOWN' && !h4Up) return 'SHORT'
  return 'NEUTRAL'
}
