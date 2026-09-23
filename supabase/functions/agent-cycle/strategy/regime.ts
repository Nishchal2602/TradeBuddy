import { InsufficientDataError } from '../indicators/calculate.ts'
import { TREND_MA_LOOKBACK_DAYS } from '../../../../src/shared/strategy/types.ts'
import type { RegimeResult } from '../../../../src/shared/strategy/types.ts'

// trading-strategy-v1.md §7 — the entire directional signal. Pure: no
// model, no Supabase, no I/O, no sizing. Mirrors indicators/calculate.ts's
// own split (types in src/shared/, computation here) and its fail-closed
// convention (InsufficientDataError, reused rather than a parallel class
// for the identical failure mode).

export function simpleMovingAverage(closes: readonly number[], period: number): number {
  if (closes.length < period) throw new InsufficientDataError('simple moving average', period, closes.length)
  const window = closes.slice(-period)
  return window.reduce((sum, c) => sum + c, 0) / period
}

// Input is the already-closed-bar-filtered dailyCloseSeries (see
// closed-bars.ts) — this function does not re-check bar closure, only
// sufficiency. checkMarketDataFreshness (cycle/build-context.ts) is the
// fail-closed gate for the whole cycle; this throwing is the pure-module
// backstop for anyone calling evaluateTrendRegime directly (e.g. a test,
// or a future backtester — trading-strategy-v1.md §22's explicit "no
// duplicate strategy logic" requirement).
export function evaluateTrendRegime(
  dailyCloseSeries: readonly { timestamp: string; close: number }[],
): RegimeResult {
  if (dailyCloseSeries.length < TREND_MA_LOOKBACK_DAYS) {
    throw new InsufficientDataError('trend regime (50-day MA)', TREND_MA_LOOKBACK_DAYS, dailyCloseSeries.length)
  }

  const closes = dailyCloseSeries.map((p) => p.close)
  const dailyMa = simpleMovingAverage(closes, TREND_MA_LOOKBACK_DAYS)
  const dailyClose = closes[closes.length - 1]!

  // strategy-v1.md §7, verbatim: "daily_close > SMA50 -> UP; daily_close <=
  // SMA50 -> DOWN" — equality is DOWN, deliberately (src/shared/strategy/
  // types.ts's TrendRegime doc comment). Strict `>`, not `>=`.
  return {
    regime: dailyClose > dailyMa ? 'UP' : 'DOWN',
    dailyClose,
    dailyMa,
    barsUsed: TREND_MA_LOOKBACK_DAYS,
  }
}
