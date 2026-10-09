import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import { buildMonthlySeries, computeNeweyWestE2, hacCovariance, hacVariance, neweyWestLag } from './newey-west.ts'
import type { TradeObservation } from './newey-west.ts'

function trade(openedAt: string, closedAt: string, r: number): TradeObservation {
  return { openedAt, closedAt, r }
}

// --- buildMonthlySeries --------------------------------------------------

Deno.test('buildMonthlySeries: a trade is assigned to its CLOSING month, never its opening month', () => {
  const trades = [trade('2020-01-20', '2020-02-05', 10)]
  const series = buildMonthlySeries(trades, '2020-01', '2020-02')
  assertEquals(series, [
    { month: '2020-01', sumR: 0, count: 0 },
    { month: '2020-02', sumR: 10, count: 1 },
  ])
})

Deno.test('buildMonthlySeries: every month in the span appears, zero-trade months are the well-defined pair (0,0)', () => {
  const trades = [trade('2020-01-01', '2020-01-05', 1)]
  const series = buildMonthlySeries(trades, '2020-01', '2020-04')
  assertEquals(series.map((s) => s.month), ['2020-01', '2020-02', '2020-03', '2020-04'])
  assertEquals(series[1], { month: '2020-02', sumR: 0, count: 0 })
  assertEquals(series[2], { month: '2020-03', sumR: 0, count: 0 })
})

Deno.test('buildMonthlySeries: multiple trades closing in the same month sum correctly', () => {
  const trades = [trade('2020-01-01', '2020-01-05', 1), trade('2020-01-10', '2020-01-20', 2), trade('2020-01-15', '2020-01-25', -0.5)]
  const series = buildMonthlySeries(trades, '2020-01', '2020-01')
  assertEquals(series, [{ month: '2020-01', sumR: 2.5, count: 3 }])
})

Deno.test('buildMonthlySeries: correctly crosses a year boundary', () => {
  const trades = [trade('2020-12-20', '2020-12-28', 1), trade('2021-01-02', '2021-01-10', 2)]
  const series = buildMonthlySeries(trades, '2020-11', '2021-02')
  assertEquals(series.map((s) => s.month), ['2020-11', '2020-12', '2021-01', '2021-02'])
  assertEquals(series[1]!.sumR, 1)
  assertEquals(series[2]!.sumR, 2)
})

// --- neweyWestLag ----------------------------------------------------

Deno.test('neweyWestLag: matches the formula at specific T values', () => {
  assertEquals(neweyWestLag(100), 4) // floor(4*1^(2/9)) = 4
  assertEquals(neweyWestLag(16), 2) // floor(4*0.16^(2/9)) ≈ floor(2.662) = 2
})

Deno.test('neweyWestLag: monotonically non-decreasing in T', () => {
  let prev = neweyWestLag(10)
  for (const t of [20, 50, 100, 200, 500]) {
    const lag = neweyWestLag(t)
    if (lag < prev) throw new Error(`expected non-decreasing lag, got ${lag} after ${prev} at T=${t}`)
    prev = lag
  }
})

// --- hacVariance / hacCovariance ---------------------------------------

Deno.test('hacVariance: at lag=0, equals the plain population-style variance of the mean (gamma0/T)', () => {
  const x = [1, 2, 3, 4, 5]
  const xbar = 3
  const gamma0 = x.reduce((a, v) => a + (v - xbar) ** 2, 0) / x.length
  assertAlmostEquals(hacVariance(x, 0), gamma0 / x.length, 1e-12)
})

Deno.test('hacVariance: a strongly positively-autocorrelated (trending) series has larger HAC variance than the naive lag-0 figure', () => {
  // A persistent AR(1)-like series: each point close to the last.
  const x: number[] = [0]
  for (let i = 1; i < 60; i++) x.push(x[i - 1]! * 0.9 + (i % 2 === 0 ? 0.1 : -0.05))
  const naive = hacVariance(x, 0)
  const hac = hacVariance(x, neweyWestLag(x.length))
  if (!(hac > naive)) throw new Error(`expected HAC variance (${hac}) > naive (${naive}) for an autocorrelated series`)
})

Deno.test('hacCovariance: symmetric under swapping the two series', () => {
  const x = [1, 3, 2, 5, 4, 6, 3, 7]
  const y = [2, 1, 4, 3, 6, 5, 8, 2]
  assertAlmostEquals(hacCovariance(x, y, 2), hacCovariance(y, x, 2), 1e-12)
})

Deno.test('hacCovariance: throws on mismatched series lengths', () => {
  let threw = false
  try {
    hacCovariance([1, 2, 3], [1, 2], 0)
  } catch {
    threw = true
  }
  assertEquals(threw, true)
})

Deno.test('hacCovariance: at lag=0, equals the plain population-style covariance', () => {
  const x = [1, 2, 3, 4]
  const y = [4, 3, 2, 1]
  const xbar = 2.5
  const ybar = 2.5
  const expected = x.reduce((a, v, i) => a + (v - xbar) * (y[i]! - ybar), 0) / x.length / x.length
  assertAlmostEquals(hacCovariance(x, y, 0), expected, 1e-12)
})

// --- computeNeweyWestE2 --------------------------------------------------

Deno.test('computeNeweyWestE2: E2 is the ratio of total sum to total count (pooled mean), matching the ICC estimator on the same data', () => {
  const monthly = [
    { month: '2020-01', sumR: 4, count: 2 }, // mean 2
    { month: '2020-02', sumR: 0, count: 0 },
    { month: '2020-03', sumR: 12, count: 2 }, // mean 6
  ]
  const result = computeNeweyWestE2(monthly)
  assertAlmostEquals(result.e2, 16 / 4, 1e-9) // (4+0+12)/(2+0+2) = 4
  assertEquals(result.t, 3)
})

Deno.test('computeNeweyWestE2: CI is well-ordered around the point estimate', () => {
  const monthly = Array.from({ length: 24 }, (_, i) => ({ month: `2020-${String((i % 12) + 1).padStart(2, '0')}`, sumR: (i % 3) - 1, count: 5 }))
  const result = computeNeweyWestE2(monthly)
  if (!(result.ciLower <= result.e2 && result.e2 <= result.ciUpper)) {
    throw new Error(`expected ciLower <= e2 <= ciUpper, got [${result.ciLower}, ${result.e2}, ${result.ciUpper}]`)
  }
})

Deno.test('computeNeweyWestE2: all-zero-trade series (totalN=0) returns e2=0 rather than NaN/dividing by zero', () => {
  const monthly = [
    { month: '2020-01', sumR: 0, count: 0 },
    { month: '2020-02', sumR: 0, count: 0 },
  ]
  const result = computeNeweyWestE2(monthly)
  assertEquals(result.e2, 0)
  assertEquals(Number.isNaN(result.se), false)
})

Deno.test('computeNeweyWestE2: a single-month series (T=1) does not throw (degenerate df=1 fallback)', () => {
  const monthly = [{ month: '2020-01', sumR: 5, count: 2 }]
  const result = computeNeweyWestE2(monthly)
  assertEquals(result.e2, 2.5)
  assertEquals(Number.isNaN(result.se), false)
})
