import { InsufficientDataError } from '../../indicators/calculate.ts'
import type { IntradaySpotPoint } from './types.ts'

// Aggressive strategy — deterministic short-horizon feature definitions,
// frozen before implementation per the migration plan §7: "a later
// redefinition can't silently make results non-comparable." Every
// definition below is exactly what is computed — no interpretation left
// for a future reader. All features read the closed 5-minute spot+volume
// series (types.ts's IntradaySpotPoint[]) — the finest granularity this
// pipeline has (see providers/coingecko.ts's fetchIntradayMarketData).
//
// Naming discipline: every extremum/statistic derived from the 5-minute
// SAMPLED series is prefixed `sampled` throughout this file and every
// caller — these are never true 24h high/low (CoinGecko's free tier has
// no true intraday OHLC at this granularity), and must never be
// mislabelled as such downstream (persisted state, Jev's own state
// payload, or any future analysis).

export interface IntradayFeatures {
  ret15mPct: number
  ret30mPct: number
  ret60mPct: number
  realizedVol5m: number
  volumeTrendRatio: number
  sampledDayHighPct: number // distance of current price ABOVE the sampled-series close-high, as a signed pct (negative = below the high)
  sampledDayLowPct: number // distance of current price ABOVE the sampled-series close-low, as a signed pct (positive = above the low)
}

// latest closed 5m close ÷ close N points earlier − 1, expressed as a
// percentage-as-number (e.g. 1.10 means +1.10%) — the same convention
// indicators/calculate.ts's own percentage fields use throughout this
// codebase (see strategy/rules.ts's own comment on why this unit choice
// matters and where the /100 conversion, if ever needed, belongs).
function returnPct(points: readonly IntradaySpotPoint[], pointsBack: number): number {
  const n = points.length
  if (n < pointsBack + 1) throw new InsufficientDataError(`${pointsBack}-point return`, pointsBack + 1, n)
  const latest = points[n - 1]!.price
  const earlier = points[n - 1 - pointsBack]!.price
  return ((latest - earlier) / earlier) * 100
}

// stdev of 5-minute LOG returns over the trailing `windowPoints` closed
// points (default 24 = 2 hours of 5-minute bars) — realized volatility,
// not annualized, not scaled: a raw dispersion figure over exactly the
// window stated, so it means the same thing every time it's read.
function realizedVolatility(points: readonly IntradaySpotPoint[], windowPoints = 24): number {
  if (points.length < windowPoints + 1) throw new InsufficientDataError('realized volatility', windowPoints + 1, points.length)
  const slice = points.slice(-(windowPoints + 1))
  const logReturns: number[] = []
  for (let i = 1; i < slice.length; i++) {
    logReturns.push(Math.log(slice[i]!.price / slice[i - 1]!.price))
  }
  const mean = logReturns.reduce((sum, r) => sum + r, 0) / logReturns.length
  const variance = logReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / logReturns.length
  return Math.sqrt(variance)
}

// mean volume over the last 6 points (30 min) ÷ mean volume over the last
// 24 points (2h) — a short-vs-longer window ratio, > 1 means recent
// volume is elevated relative to the last two hours.
function volumeTrend(points: readonly IntradaySpotPoint[]): number {
  if (points.length < 24) throw new InsufficientDataError('volume trend', 24, points.length)
  const meanOf = (n: number) => {
    const slice = points.slice(-n)
    return slice.reduce((sum, p) => sum + p.volume, 0) / slice.length
  }
  const longWindowMean = meanOf(24)
  if (longWindowMean === 0) return 1 // no volume signal at all — neutral, not a divide-by-zero throw
  return meanOf(6) / longWindowMean
}

// Distance of the CURRENT (latest) price from the sampled-series close-
// high/low, as a SIGNED percentage. High: 0 or negative (current price
// can't exceed the max of a series that includes itself, so 0 means
// current IS the high). Low: 0 or positive, symmetric reasoning.
function sampledExtremeDistances(points: readonly IntradaySpotPoint[]): { sampledDayHighPct: number; sampledDayLowPct: number } {
  if (points.length === 0) throw new InsufficientDataError('sampled day high/low', 1, 0)
  const current = points[points.length - 1]!.price
  const high = Math.max(...points.map((p) => p.price))
  const low = Math.min(...points.map((p) => p.price))
  return {
    sampledDayHighPct: ((current - high) / high) * 100,
    sampledDayLowPct: ((current - low) / low) * 100,
  }
}

// The one entry point strategy/registry.ts and the aggressive management-
// question builder call. Requires at least 25 closed 5-minute points (the
// realized-volatility window's own minimum, the largest of the four) —
// the real pipeline supplies ~289 (24h), so this floor exists only to
// fail closed on a malformed/truncated upstream response, same
// discipline as indicators/calculate.ts's own InsufficientDataError uses.
export function computeIntradayFeatures(points: readonly IntradaySpotPoint[]): IntradayFeatures {
  if (points.length < 25) throw new InsufficientDataError('intraday features', 25, points.length)
  const { sampledDayHighPct, sampledDayLowPct } = sampledExtremeDistances(points)
  return {
    ret15mPct: returnPct(points, 3),
    ret30mPct: returnPct(points, 6),
    ret60mPct: returnPct(points, 12),
    realizedVol5m: realizedVolatility(points),
    volumeTrendRatio: volumeTrend(points),
    sampledDayHighPct,
    sampledDayLowPct,
  }
}
