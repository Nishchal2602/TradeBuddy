// DT-1 (2026-10-09) — the second of E2's three dependence estimators
// (plan §6.4h): Newey-West HAC on a corrected monthly series. Series
// construction: EACH TRADE ASSIGNED ONLY TO ITS CLOSING MONTH (never
// double-counted across every month it was open), with every month in
// the evaluation span represented -- including a zero-trade month as
// the well-defined pair (0, 0), never a gap that silently drops out and
// biases the autocorrelation estimate. E2 is the RATIO-OF-SUMS estimator
// (sum of all trade R / count of all trades), algebraically identical to
// the plain pooled mean -- what Newey-West buys here is a standard error
// that accounts for month-to-month autocorrelation in both the sum and
// count series, via the delta method on their HAC-estimated covariance
// structure.

import { studentTCriticalValue } from './student-t.ts'

export interface TradeObservation {
  openedAt: string
  closedAt: string
  r: number
}

export interface MonthlySeriesPoint {
  month: string // YYYY-MM
  sumR: number
  count: number
}

function monthOf(iso: string): string {
  return iso.slice(0, 7)
}

function addMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y!, m! - 1 + 1, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

// Builds the monthly (sumR, count) series over [fromMonth, toMonth]
// inclusive, assigning each trade to its CLOSING month only. Every month
// in the span appears exactly once, in order -- a month with zero
// closing trades is (0, 0), never omitted (plan §6.4h: "zero-trade
// months correctly defined as (0,0), never dropped").
export function buildMonthlySeries(trades: readonly TradeObservation[], fromMonth: string, toMonth: string): MonthlySeriesPoint[] {
  const byMonth = new Map<string, { sumR: number; count: number }>()
  for (const t of trades) {
    const m = monthOf(t.closedAt)
    const existing = byMonth.get(m)
    if (existing) {
      existing.sumR += t.r
      existing.count += 1
    } else {
      byMonth.set(m, { sumR: t.r, count: 1 })
    }
  }

  const series: MonthlySeriesPoint[] = []
  let month = fromMonth
  // Safety bound: never loop forever on a malformed (fromMonth > toMonth,
  // or non-month-shaped) input.
  for (let i = 0; i < 100_000 && month <= toMonth; i++) {
    const bucket = byMonth.get(month)
    series.push({ month, sumR: bucket?.sumR ?? 0, count: bucket?.count ?? 0 })
    month = addMonth(month)
  }
  return series
}

// Automatic Newey-West lag rule (plan §6.4h): L = floor(4*(T/100)^(2/9)).
export function neweyWestLag(t: number): number {
  return Math.floor(4 * Math.pow(t / 100, 2 / 9))
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

// Newey-West (Bartlett-kernel) long-run variance of the SAMPLE MEAN of a
// single series -- Var(x̄), not Var(x_t).
export function hacVariance(x: readonly number[], lag: number): number {
  const t = x.length
  const xbar = mean(x)
  const dev = x.map((v) => v - xbar)
  let gamma0 = 0
  for (const d of dev) gamma0 += d * d
  gamma0 /= t

  let s = gamma0
  for (let j = 1; j <= lag; j++) {
    let gammaJ = 0
    for (let i = j; i < t; i++) gammaJ += dev[i]! * dev[i - j]!
    gammaJ /= t
    const w = 1 - j / (lag + 1)
    s += 2 * w * gammaJ
  }
  return s / t
}

// Newey-West long-run COVARIANCE of two series' sample means -- Cov(x̄,ȳ).
// The cross-autocovariance at lag j is generally asymmetric (gamma_xy(j)
// != gamma_yx(j)), so both directions are accumulated, matching the
// standard HAC generalization to a covariance (as opposed to a single
// series' variance).
export function hacCovariance(x: readonly number[], y: readonly number[], lag: number): number {
  if (x.length !== y.length) throw new Error('hacCovariance: series must have equal length')
  const t = x.length
  const xbar = mean(x)
  const ybar = mean(y)
  const devX = x.map((v) => v - xbar)
  const devY = y.map((v) => v - ybar)

  let gamma0 = 0
  for (let i = 0; i < t; i++) gamma0 += devX[i]! * devY[i]!
  gamma0 /= t

  let s = gamma0
  for (let j = 1; j <= lag; j++) {
    let gXY = 0
    let gYX = 0
    for (let i = j; i < t; i++) {
      gXY += devX[i]! * devY[i - j]!
      gYX += devY[i]! * devX[i - j]!
    }
    gXY /= t
    gYX /= t
    const w = 1 - j / (lag + 1)
    s += w * (gXY + gYX)
  }
  return s / t
}

export interface NeweyWestE2Result {
  e2: number
  se: number
  ciLower: number
  ciUpper: number
  lag: number
  t: number
}

// The ratio estimator E2 = sum(R) / count, its delta-method SE from the
// HAC-estimated variance/covariance of the two monthly series, the
// T/(T-1) small-sample correction, and a Student-t(T-1) reference
// interval (plan §6.4h: "a Student-t reference with T-1 degrees of
// freedom, not a Normal approximation").
export function computeNeweyWestE2(monthly: readonly MonthlySeriesPoint[], alpha = 0.10): NeweyWestE2Result {
  const t = monthly.length
  const sSeries = monthly.map((m) => m.sumR)
  const nSeries = monthly.map((m) => m.count)
  const sBar = mean(sSeries)
  const nBar = mean(nSeries)
  const totalS = sSeries.reduce((a, b) => a + b, 0)
  const totalN = nSeries.reduce((a, b) => a + b, 0)
  const lag = neweyWestLag(t)

  // No trades anywhere in the window -- the delta method's denominators
  // (nBar, nBar²) are all zero, which would otherwise produce NaN rather
  // than a well-defined "nothing to estimate" result.
  if (totalN === 0) {
    return { e2: 0, se: 0, ciLower: 0, ciUpper: 0, lag, t }
  }
  const e2 = totalS / totalN
  const varS = hacVariance(sSeries, lag)
  const varN = hacVariance(nSeries, lag)
  const covSN = hacCovariance(sSeries, nSeries, lag)

  // Delta method for g(S̄, n̄) = S̄/n̄:
  //   Var(g) ≈ Var(S̄)/n̄² - 2*(S̄/n̄³)*Cov(S̄,n̄) + (S̄²/n̄⁴)*Var(n̄)
  const nBar2 = nBar * nBar
  let varG = varS / nBar2 - (2 * sBar * covSN) / (nBar2 * nBar) + (sBar * sBar * varN) / (nBar2 * nBar2)
  // Small-sample correction (plan §6.4h).
  varG *= t / Math.max(t - 1, 1)
  const se = Math.sqrt(Math.max(varG, 0))

  const critical = studentTCriticalValue(alpha, Math.max(t - 1, 1))
  const halfWidth = critical * se

  return { e2, se, ciLower: e2 - halfWidth, ciUpper: e2 + halfWidth, lag, t }
}
