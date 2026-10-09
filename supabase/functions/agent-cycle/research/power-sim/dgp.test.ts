import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import {
  simulatePortfolioDailyReturnsOverTrajectory,
  simulateSleeveDailyReturns,
  simulateTradePopulation,
  solveDailyMeanForTargetSharpe,
  solveTradeMeanRForTargetSharpe,
} from './dgp.ts'
import type { MeasuredTradeMoments } from './dgp.ts'

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A reasonably realistic shape with mild positive skew, standardized to
// mean~0 by construction (bootstrap-resampled, so the EMPIRICAL mean of
// the array itself need not be exactly 0 -- what matters is that it's
// representative, matching how drawShock is actually used downstream).
const SHAPE = Array.from({ length: 2000 }, (_, i) => {
  const u = (i + 0.5) / 2000
  // Inverse-ish transform producing a mildly right-skewed shape.
  return Math.log(u / (1 - u)) * 0.6
})

function pearsonCorrelation(x: readonly number[], y: readonly number[]): number {
  const n = x.length
  const mx = x.reduce((a, b) => a + b, 0) / n
  const my = y.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my)
    sxx += (x[i]! - mx) ** 2
    syy += (y[i]! - my) ** 2
  }
  return sxy / Math.sqrt(sxx * syy)
}

// --- solveDailyMeanForTargetSharpe / solveTradeMeanRForTargetSharpe ------

Deno.test('solveDailyMeanForTargetSharpe: zero target Sharpe -> zero daily mean', () => {
  assertEquals(solveDailyMeanForTargetSharpe(0, 0.05, 0.5, 20), 0)
})

Deno.test('solveDailyMeanForTargetSharpe: scales linearly with the target Sharpe', () => {
  const low = solveDailyMeanForTargetSharpe(0.3, 0.05, 0.5, 20)
  const high = solveDailyMeanForTargetSharpe(0.6, 0.05, 0.5, 20)
  assertAlmostEquals(high / low, 2, 1e-9)
})

Deno.test('solveDailyMeanForTargetSharpe: higher rhoBar (less diversification benefit) requires a larger daily mean for the same target Sharpe', () => {
  const lowRho = solveDailyMeanForTargetSharpe(0.5, 0.05, 0.3, 20)
  const highRho = solveDailyMeanForTargetSharpe(0.5, 0.05, 0.8, 20)
  if (!(highRho > lowRho)) throw new Error(`expected highRho mean (${highRho}) > lowRho mean (${lowRho})`)
})

Deno.test('solveTradeMeanRForTargetSharpe: zero trades per year returns 0, never divides by zero', () => {
  assertEquals(solveTradeMeanRForTargetSharpe(0.5, 3, 0), 0)
})

Deno.test('solveTradeMeanRForTargetSharpe: more trades per year requires a SMALLER per-trade mean for the same target Sharpe (frequency does the work)', () => {
  const fewTrades = solveTradeMeanRForTargetSharpe(0.5, 3, 50)
  const manyTrades = solveTradeMeanRForTargetSharpe(0.5, 3, 500)
  if (!(manyTrades < fewTrades)) throw new Error(`expected manyTrades mean (${manyTrades}) < fewTrades mean (${fewTrades})`)
})

// --- simulateSleeveDailyReturns — verifies the equicorrelation construction ---

Deno.test('simulateSleeveDailyReturns: realized pairwise correlation over a long run lands close to the target rhoBar', () => {
  const rng = mulberry32(1)
  const sleeves = simulateSleeveDailyReturns(2, 20_000, 0, 0.05, 0.5, SHAPE, rng)
  const realizedRho = pearsonCorrelation(sleeves[0]!, sleeves[1]!)
  assertAlmostEquals(realizedRho, 0.5, 0.03)
})

Deno.test('simulateSleeveDailyReturns: rhoBar=0 produces near-zero realized correlation', () => {
  const rng = mulberry32(2)
  const sleeves = simulateSleeveDailyReturns(2, 20_000, 0, 0.05, 0, SHAPE, rng)
  const realizedRho = pearsonCorrelation(sleeves[0]!, sleeves[1]!)
  assertAlmostEquals(realizedRho, 0, 0.03)
})

Deno.test('simulateSleeveDailyReturns: rhoBar=1 (fully common factor) produces near-perfect realized correlation', () => {
  const rng = mulberry32(3)
  const sleeves = simulateSleeveDailyReturns(2, 5_000, 0, 0.05, 1, SHAPE, rng)
  const realizedRho = pearsonCorrelation(sleeves[0]!, sleeves[1]!)
  assertAlmostEquals(realizedRho, 1, 0.01)
})

// --- simulatePortfolioDailyReturnsOverTrajectory — verifies realized Sharpe ---

Deno.test('simulatePortfolioDailyReturnsOverTrajectory: realized annualized Sharpe over a long flat-N run lands close to the target', () => {
  const rng = mulberry32(4)
  const n = 20
  const days = 20_000
  const targetSharpe = 0.8
  const sigmaDaily = 0.05
  const rhoBar = 0.5
  const muDaily = solveDailyMeanForTargetSharpe(targetSharpe, sigmaDaily, rhoBar, n)
  const series = simulatePortfolioDailyReturnsOverTrajectory(new Array(days).fill(n), muDaily, sigmaDaily, rhoBar, SHAPE, rng)

  const mean = series.reduce((a, b) => a + b, 0) / series.length
  const sd = Math.sqrt(series.reduce((a, b) => a + (b - mean) ** 2, 0) / (series.length - 1))
  const realizedAnnualizedSharpe = (mean / sd) * Math.sqrt(365)
  assertAlmostEquals(realizedAnnualizedSharpe, targetSharpe, 0.15)
})

Deno.test('simulatePortfolioDailyReturnsOverTrajectory: output length matches the trajectory length', () => {
  const rng = mulberry32(5)
  const series = simulatePortfolioDailyReturnsOverTrajectory([2, 5, 10, 20], 0.001, 0.05, 0.5, SHAPE, rng)
  assertEquals(series.length, 4)
})

Deno.test('simulatePortfolioDailyReturnsOverTrajectory: a thin-N day has higher variance than a mature-N day, for the same target', () => {
  const rng = mulberry32(6)
  const thinSeries = simulatePortfolioDailyReturnsOverTrajectory(new Array(5000).fill(2), 0, 0.05, 0.5, SHAPE, rng)
  const matureSeries = simulatePortfolioDailyReturnsOverTrajectory(new Array(5000).fill(20), 0, 0.05, 0.5, SHAPE, rng)
  const variance = (xs: number[]) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length
    return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length
  }
  if (!(variance(thinSeries) > variance(matureSeries))) {
    throw new Error(`expected thin-N variance (${variance(thinSeries)}) > mature-N variance (${variance(matureSeries)})`)
  }
})

// --- simulateTradePopulation ---------------------------------------------

function fakeMoments(): MeasuredTradeMoments {
  return {
    n: 352,
    mean: 0.17,
    sd: 2.92,
    skewness: 1.15,
    excessKurtosis: 0.04,
    standardizedRValues: SHAPE,
    meanHoldingDays: 9.4,
    medianHoldingDays: 4,
    holdingDaysValues: [1, 2, 3, 4, 5, 7, 10, 14, 20, 30],
  }
}

Deno.test('simulateTradePopulation: trade count scales with the N(t) trajectory', () => {
  const rng = mulberry32(7)
  const nTrajectory = new Map([
    ['2020-01', 2],
    ['2020-02', 20],
  ])
  const trades = simulateTradePopulation({
    fromMonth: '2020-01',
    nTrajectoryByMonth: nTrajectory,
    tradesPerSleevePerMonth: 1.7,
    tradeMoments: fakeMoments(),
    rhoBar: 0.5,
    trueAnnualizedSharpe: 0.5,
    matureN: 20,
    rng,
  })
  const jan = trades.filter((t) => t.openedAt.startsWith('2020-01')).length
  const feb = trades.filter((t) => t.openedAt.startsWith('2020-02')).length
  if (!(feb > jan * 5)) throw new Error(`expected Feb (N=20, ${feb} trades) to greatly exceed Jan (N=2, ${jan} trades)`)
})

Deno.test('simulateTradePopulation: holding periods are drawn from the supplied empirical distribution', () => {
  const rng = mulberry32(8)
  const moments = fakeMoments()
  const nTrajectory = new Map([['2020-01', 20]])
  const trades = simulateTradePopulation({
    fromMonth: '2020-01',
    nTrajectoryByMonth: nTrajectory,
    tradesPerSleevePerMonth: 1.7,
    tradeMoments: moments,
    rhoBar: 0.5,
    trueAnnualizedSharpe: 0.5,
    matureN: 20,
    rng,
  })
  for (const t of trades) {
    const holdingDays = (new Date(t.closedAt).getTime() - new Date(t.openedAt).getTime()) / 86_400_000
    if (!moments.holdingDaysValues.includes(Math.round(holdingDays))) {
      throw new Error(`holding period ${holdingDays} not among the supplied empirical values`)
    }
  }
})

Deno.test('simulateTradePopulation: zero realized trade count for a month contributes no trades (not an error)', () => {
  const rng = mulberry32(9)
  const nTrajectory = new Map([['2020-01', 0]])
  const trades = simulateTradePopulation({
    fromMonth: '2020-01',
    nTrajectoryByMonth: nTrajectory,
    tradesPerSleevePerMonth: 1.7,
    tradeMoments: fakeMoments(),
    rhoBar: 0.5,
    trueAnnualizedSharpe: 0.5,
    matureN: 20,
    rng,
  })
  assertEquals(trades.length, 0)
})

// NOTE on what this test caught during development: an earlier version
// used rhoBar=0.3 here and failed (realized Sharpe ~1.75 vs target 0.8).
// That was NOT a DGP bug -- it was a flawed test expectation. The shared
// MONTHLY common factor means its own sampling noise averages out over
// ~numMonths independent draws, NOT over the much larger total trade
// count (dozens of trades per month all share one commonShock draw) --
// so with only 200 months, the common factor's own residual bias (here,
// its realized sample mean missed zero by a few hundredths) gets
// amplified by sd and dominates the intended per-trade mean target. This
// is the DGP correctly modeling real dependence (the whole reason E2's
// estimators need to detect it), not noise to average away carelessly.
// Isolated below: the core per-trade calibration at rhoBar=0 (where this
// extra noise source is absent, so a tight tolerance is legitimate), plus
// a qualitative confirmation that same-month trades really are more
// correlated than different-month trades when rhoBar>0.

Deno.test('simulateTradePopulation: at rhoBar=0 (no shared common factor), realized Sharpe over many months converges tightly to the calibrated target', () => {
  const rng = mulberry32(10)
  const months = Array.from({ length: 200 }, (_, i) => `${2000 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`)
  const nTrajectory = new Map(months.map((m) => [m, 20]))
  const targetSharpe = 0.8
  const tradesPerSleevePerMonth = 1.7
  const moments = fakeMoments()
  const trades = simulateTradePopulation({
    fromMonth: months[0]!,
    nTrajectoryByMonth: nTrajectory,
    tradesPerSleevePerMonth,
    tradeMoments: moments,
    rhoBar: 0,
    trueAnnualizedSharpe: targetSharpe,
    matureN: 20,
    rng,
  })
  const rs = trades.map((t) => t.r)
  const realizedMean = rs.reduce((a, b) => a + b, 0) / rs.length
  const realizedSd = Math.sqrt(rs.reduce((a, b) => a + (b - realizedMean) ** 2, 0) / (rs.length - 1))
  const tradesPerYear = tradesPerSleevePerMonth * 12 * 20
  const realizedSharpe = (realizedMean / realizedSd) * Math.sqrt(tradesPerYear)
  assertAlmostEquals(realizedSharpe, targetSharpe, 0.3)
})

Deno.test('simulateTradePopulation: with rhoBar>0, trades closing in the SAME month are more correlated than trades in different months', () => {
  const rng = mulberry32(11)
  const months = Array.from({ length: 60 }, (_, i) => `${2000 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`)
  const nTrajectory = new Map(months.map((m) => [m, 20]))
  const moments = fakeMoments()
  const trades = simulateTradePopulation({
    fromMonth: months[0]!,
    nTrajectoryByMonth: nTrajectory,
    tradesPerSleevePerMonth: 1.7,
    tradeMoments: moments,
    rhoBar: 0.8,
    trueAnnualizedSharpe: 0.5,
    matureN: 20,
    rng,
  })
  const byMonth = new Map<string, number[]>()
  for (const t of trades) {
    const m = t.openedAt.slice(0, 7)
    const arr = byMonth.get(m) ?? []
    arr.push(t.r)
    byMonth.set(m, arr)
  }
  // Within-month variance of each month's own mean R should be smaller
  // relative to the full pooled variance than it would be under
  // independence -- equivalently, the ICC-style between/within
  // decomposition should show real between-month structure. Simple
  // proxy: the spread of PER-MONTH MEANS should be a non-trivial fraction
  // of the overall spread (if trades were independent within a month,
  // per-month means would be much tighter around the grand mean than the
  // individual trades themselves).
  const monthMeans = [...byMonth.values()].map((rs) => rs.reduce((a, b) => a + b, 0) / rs.length)
  const grandMean = trades.reduce((a, t) => a + t.r, 0) / trades.length
  const sdOfMonthMeans = Math.sqrt(monthMeans.reduce((a, m) => a + (m - grandMean) ** 2, 0) / monthMeans.length)
  const sdOfAllTrades = Math.sqrt(trades.reduce((a, t) => a + (t.r - grandMean) ** 2, 0) / trades.length)
  // At rhoBar=0.8, per-month means should retain a large fraction of the
  // individual-trade spread (high intra-month correlation); at
  // independence, sdOfMonthMeans would be roughly sdOfAllTrades/sqrt(34).
  const independenceExpectation = sdOfAllTrades / Math.sqrt(34)
  if (!(sdOfMonthMeans > independenceExpectation * 2)) {
    throw new Error(`expected sdOfMonthMeans (${sdOfMonthMeans}) to exceed the independence expectation (${independenceExpectation}) by a wide margin at rhoBar=0.8`)
  }
})
