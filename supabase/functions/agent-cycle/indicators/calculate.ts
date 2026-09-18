import type { OhlcCandle, NormalizedMarketData, VolumePoint } from '../../../../src/shared/market-data/types.ts'
import { MarketIndicators, RecentClose } from '../../../../src/shared/indicators/types.ts'

// Raised when an input series is too short for a given indicator's minimum
// window. In production this should never fire — a 30-day CoinGecko window
// gives ~721 hourly closes and ~180 4-hourly candles (Unit 3), vastly above
// every minimum below — so it exists as a fail-closed guard against
// malformed/truncated upstream data, not a normal-operation branch
// (code-standards.md "fail closed for trading decisions").
export class InsufficientDataError extends Error {
  constructor(indicator: string, need: number, have: number) {
    super(`${indicator}: need at least ${need} data points, got ${have}`)
    this.name = 'InsufficientDataError'
  }
}

// --- Generic numeric primitives --------------------------------------------
// Kept to exactly the two building blocks genuinely shared across multiple
// indicators below. RSI and ATR each apply Wilder's smoothing directly
// rather than through a shared helper — the recurrence shape rhymes but the
// inputs (gain/loss vs. true range) differ enough that factoring it out
// would be an abstraction for two call sites, not a real one.

function sma(values: number[], period: number): number {
  const window = values.slice(-period)
  return window.reduce((sum, v) => sum + v, 0) / window.length
}

// Full EMA series aligned to `values`, undefined before the SMA-seeded
// index (i.e. before `period - 1`). MACD needs the whole series (to derive
// its own EMA-of-a-series signal line); EMA20/EMA50 just read the last
// defined entry.
function emaSeries(values: number[], period: number): (number | undefined)[] {
  const k = 2 / (period + 1)
  const result: (number | undefined)[] = new Array(values.length).fill(undefined)
  if (values.length < period) return result

  let prevEma = sma(values.slice(0, period), period)
  result[period - 1] = prevEma

  for (let i = period; i < values.length; i++) {
    const value = values[i]!
    const currentEma = value * k + prevEma * (1 - k)
    result[i] = currentEma
    prevEma = currentEma
  }
  return result
}

function lastDefined(series: (number | undefined)[]): number {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i]
    if (v !== undefined) return v
  }
  throw new Error('lastDefined: series has no defined values')
}

// --- Individual indicators --------------------------------------------------

export function calculateEMA(closes: number[], period: number): number {
  if (closes.length < period) throw new InsufficientDataError(`EMA${period}`, period, closes.length)
  return lastDefined(emaSeries(closes, period))
}

// Wilder's RSI (the standard definition — not a simple gain/loss ratio over
// a plain moving average).
export function calculateRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) throw new InsufficientDataError('RSI', period + 1, closes.length)

  const gains: number[] = []
  const losses: number[] = []
  for (let i = 1; i < closes.length; i++) {
    const delta = closes[i]! - closes[i - 1]!
    gains.push(Math.max(delta, 0))
    losses.push(Math.max(-delta, 0))
  }

  let avgGain = sma(gains.slice(0, period), period)
  let avgLoss = sma(losses.slice(0, period), period)

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]!) / period
    avgLoss = (avgLoss * (period - 1) + losses[i]!) / period
  }

  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

// Standard 12/26/9 MACD, returning only the histogram (MACD line minus
// signal line) — the line and signal values themselves aren't part of
// MarketIndicators (project-overview.md only asks for the histogram).
export function calculateMACDHistogram(closes: number[]): number {
  const FAST = 12
  const SLOW = 26
  const SIGNAL = 9
  const minRequired = SLOW + SIGNAL
  if (closes.length < minRequired) {
    throw new InsufficientDataError('MACD', minRequired, closes.length)
  }

  const fastSeries = emaSeries(closes, FAST)
  const slowSeries = emaSeries(closes, SLOW)

  // MACD line is only defined once both EMAs are (from index SLOW-1 on).
  const macdLine: number[] = []
  for (let i = SLOW - 1; i < closes.length; i++) {
    macdLine.push(fastSeries[i]! - slowSeries[i]!)
  }

  const signalSeries = emaSeries(macdLine, SIGNAL)
  const signal = lastDefined(signalSeries)
  const macdLast = macdLine[macdLine.length - 1]!

  return macdLast - signal
}

// Wilder's ATR, expressed as a percentage of the latest close (ATR% —
// project-overview.md's naming) rather than an absolute price unit, so it's
// comparable across BTC and ETH's very different price scales.
export function calculateATRPercent(candles: OhlcCandle[], period = 14): number {
  if (candles.length < period + 1) throw new InsufficientDataError('ATR', period + 1, candles.length)

  const trueRanges: number[] = [candles[0]!.high - candles[0]!.low]
  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i]!
    const prevClose = candles[i - 1]!.close
    trueRanges.push(Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - prevClose),
      Math.abs(candle.low - prevClose),
    ))
  }

  let atr = sma(trueRanges.slice(0, period), period)
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]!) / period
  }

  const lastClose = candles[candles.length - 1]!.close
  return (atr / lastClose) * 100
}

// Ratio of the most recent volume to the trailing `period`-point average
// (the average includes the most recent point — a deliberate simplicity
// choice, not a claim that excluding it would be wrong).
export function calculateVolumeRatio(volumeSeries: VolumePoint[], period = 20): number {
  if (volumeSeries.length < period) throw new InsufficientDataError('volume ratio', period, volumeSeries.length)

  const recent = volumeSeries.slice(-period)
  const average = recent.reduce((sum, v) => sum + v.volume, 0) / recent.length
  const latest = volumeSeries[volumeSeries.length - 1]!.volume
  return average === 0 ? 0 : latest / average
}

// Slices candles to the last 7 days by timestamp (not by element count —
// robust to any provider gaps rather than assuming perfectly uniform
// spacing), then reports the live spot price's signed distance from that
// window's high and low.
export function calculateDistanceFromSevenDayRange(
  candles: OhlcCandle[],
  currentPrice: number,
): { distanceFromHighPct: number; distanceFromLowPct: number } {
  if (candles.length === 0) throw new InsufficientDataError('7d high/low', 1, 0)

  const latestTimestamp = new Date(candles[candles.length - 1]!.timestamp).getTime()
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
  const windowStart = latestTimestamp - sevenDaysMs

  const window = candles.filter((c) => new Date(c.timestamp).getTime() >= windowStart)
  if (window.length === 0) throw new InsufficientDataError('7d high/low', 1, 0)

  const sevenDayHigh = Math.max(...window.map((c) => c.high))
  const sevenDayLow = Math.min(...window.map((c) => c.low))

  return {
    distanceFromHighPct: ((currentPrice - sevenDayHigh) / sevenDayHigh) * 100,
    distanceFromLowPct: ((currentPrice - sevenDayLow) / sevenDayLow) * 100,
  }
}

// --- Orchestration -----------------------------------------------------

export function calculateIndicators(data: NormalizedMarketData): MarketIndicators {
  const closes = data.closeSeries.map((point) => point.close)
  const { distanceFromHighPct, distanceFromLowPct } = calculateDistanceFromSevenDayRange(
    data.candles,
    data.price,
  )

  const indicators: MarketIndicators = {
    rsi14: calculateRSI(closes, 14),
    ema20: calculateEMA(closes, 20),
    ema50: calculateEMA(closes, 50),
    macdHistogram: calculateMACDHistogram(closes),
    atrPct: calculateATRPercent(data.candles, 14),
    volumeRatio: calculateVolumeRatio(data.volumeSeries, 20),
    distanceFromSevenDayHighPct: distanceFromHighPct,
    distanceFromSevenDayLowPct: distanceFromLowPct,
  }

  return MarketIndicators.parse(indicators)
}

// The ~24-point "recent closes" shape context (project-overview.md), read
// from closeSeries (hourly) — not candles (4-hourly) — since that's the
// series that's actually hourly on the free CoinGecko tier (Unit 3).
export function getRecentCloses(data: NormalizedMarketData, count = 24): RecentClose[] {
  return data.closeSeries.slice(-count).map((point) => RecentClose.parse(point))
}
