import { computeE2 } from '../dependence/e2-estimators.ts'
import type { TradeObservation } from '../dependence/e2-estimators.ts'
import { politisWhiteBlockLength, stationaryBootstrapCI } from '../dependence/block-bootstrap.ts'
import { buildCpcvSplits, deflatedSharpeRatio } from '../stats.ts'
import type { TimedInterval } from '../stats.ts'
import { simulatePortfolioDailyReturnsOverTrajectory, simulateTradePopulation, solveDailyMeanForTargetSharpe } from './dgp.ts'
import type { MeasuredInputs, Scenario } from './dgp.ts'
import { REGISTRY_VARIANT_SHARPES_DAILY_RESAMPLED } from './registry-sharpes.ts'

// DT-1 (2026-10-09, Order-of-Work step 5) — runs ONE Monte Carlo replicate
// of the power simulation (plan §6.7b): simulates both the daily
// portfolio-return series (E1) and the trade population (E2) for a given
// (rhoBar, trueAnnualizedSharpe) scenario, then runs them through the
// SAME analysis pipeline DT-1's real run will use.
//
// PRIMARY economic-power metric (condition 1 of §6.8's three-condition
// "Supported" verdict): E1's bootstrap CI lower bound exceeds the
// required Sharpe (0.54, frozen by A10 -- never touched here). The
// robustness condition (3) is also computed, since it is cheap given a
// daily series. The MaxDD veto (condition 2, L-scaled bootstrap
// drawdowns) is EXPLICITLY OUT OF SCOPE for this round, stated plainly
// rather than rushed: it needs its own careful design (the L=sigma_max/
// sigma_realized scaling, the 90th-percentile-across-resamples
// construction) that was not built under this unit's time budget. The
// simulation's power estimate is therefore a measure of condition 1 ALONE,
// not the full three-condition verdict -- reported as such, never
// silently presented as the complete "Supported" power.

const REQUIRED_SHARPE = 0.54 // A10 / S6.8 -- frozen; this module only ever READS it
const CPCV_NUM_GROUPS = 10
const CPCV_TEST_GROUPS_PER_SPLIT = 2
const CPCV_EMBARGO_MS = 14 * 86_400_000

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}
function sampleStdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}
function populationVariance(xs: readonly number[]): number {
  const m = mean(xs)
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length
}

function annualizedSharpeOf(series: readonly number[]): number {
  const sd = sampleStdev(series)
  return sd === 0 ? 0 : (mean(series) / sd) * Math.sqrt(365)
}
function perPeriodSharpeOf(series: readonly number[]): number {
  const sd = sampleStdev(series)
  return sd === 0 ? 0 : mean(series) / sd
}

// Robustness condition (§6.8): with the single best calendar year
// (approximated as a contiguous 365-day block, since the simulated
// series carries no calendar metadata of its own) removed, the point
// estimate (annualized Sharpe) must remain positive.
function computeRobustness(dailySeries: readonly number[]): boolean | null {
  const yearLen = 365
  const numYears = Math.floor(dailySeries.length / yearLen)
  if (numYears < 2) return null // not enough data for a meaningful "best year removed" check

  let bestYearIdx = 0
  let bestYearReturn = -Infinity
  for (let y = 0; y < numYears; y++) {
    const slice = dailySeries.slice(y * yearLen, (y + 1) * yearLen)
    const cumulative = slice.reduce((acc, r) => acc * (1 + r), 1)
    if (cumulative > bestYearReturn) {
      bestYearReturn = cumulative
      bestYearIdx = y
    }
  }
  const withoutBestYear = [...dailySeries.slice(0, bestYearIdx * yearLen), ...dailySeries.slice((bestYearIdx + 1) * yearLen)]
  return annualizedSharpeOf(withoutBestYear) > 0
}

function cpcvMedianSignAgreement(trades: readonly TradeObservation[]): boolean | null {
  if (trades.length < CPCV_NUM_GROUPS) return null
  const intervals: TimedInterval[] = trades.map((t) => ({ start: new Date(t.openedAt).getTime(), end: new Date(t.closedAt).getTime() }))
  const splits = buildCpcvSplits(intervals, CPCV_NUM_GROUPS, CPCV_TEST_GROUPS_PER_SPLIT, CPCV_EMBARGO_MS)
  if (splits.length === 0) return null

  const testMeans = splits.map((s) => mean(s.testIndices.map((i) => trades[i]!.r))).filter((m) => Number.isFinite(m))
  if (testMeans.length === 0) return null
  const sorted = [...testMeans].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  const fullSampleMean = mean(trades.map((t) => t.r))
  return Math.sign(median) === Math.sign(fullSampleMean) || (median === 0 && fullSampleMean === 0)
}

export interface ReplicateParams {
  scenario: Scenario
  measuredInputs: MeasuredInputs
  nTrajectoryByDay: readonly number[]
  nTrajectoryByMonth: ReadonlyMap<string, number>
  fromMonth: string
  toMonth: string
  tradesPerSleevePerMonth: number
  matureN: number
  bootstrapResamples: number
  rng: () => number
}

export interface ReplicateResult {
  e1PointEstimate: number
  e1CiLower: number
  e1CiUpper: number
  economicPowerCondition1: boolean
  robustnessConditionHolds: boolean | null
  e2Verdict: 'significant_positive' | 'significant_negative' | 'not_significant' | 'estimator_conflict'
  dsrN1: number
  dsrN14: number
  cpcvMedianSignAgrees: boolean | null
}

export function runOneReplicate(params: ReplicateParams): ReplicateResult {
  const sigmaDaily = params.measuredInputs.perSleeveDailyVolatility.medianLogReturnSd
  const shape = params.measuredInputs.tradeMoments.standardizedRValues

  const muDaily = solveDailyMeanForTargetSharpe(params.scenario.trueAnnualizedSharpe, sigmaDaily, params.scenario.rhoBar, params.matureN)
  const dailySeries = simulatePortfolioDailyReturnsOverTrajectory(params.nTrajectoryByDay, muDaily, sigmaDaily, params.scenario.rhoBar, shape, params.rng)

  const blockLength = politisWhiteBlockLength(dailySeries)
  const e1 = stationaryBootstrapCI(dailySeries, annualizedSharpeOf, {
    numResamples: params.bootstrapResamples,
    meanBlockLength: blockLength,
    rng: params.rng,
  })
  const economicPowerCondition1 = e1.ciLower > REQUIRED_SHARPE
  const robustnessConditionHolds = computeRobustness(dailySeries)

  const trades = simulateTradePopulation({
    fromMonth: params.fromMonth,
    nTrajectoryByMonth: params.nTrajectoryByMonth,
    tradesPerSleevePerMonth: params.tradesPerSleevePerMonth,
    tradeMoments: params.measuredInputs.tradeMoments,
    rhoBar: params.scenario.rhoBar,
    trueAnnualizedSharpe: params.scenario.trueAnnualizedSharpe,
    matureN: params.matureN,
    rng: params.rng,
  }) as TradeObservation[]

  const e2 = computeE2(trades, { fromMonth: params.fromMonth, toMonth: params.toMonth, numResamples: params.bootstrapResamples, rng: params.rng })
  const e2Verdict = e2.verdict.kind === 'significant' ? (e2.verdict.direction === 'positive' ? 'significant_positive' : 'significant_negative') : e2.verdict.kind === 'not_significant' ? 'not_significant' : 'estimator_conflict'

  const perPeriodSharpe = perPeriodSharpeOf(dailySeries)
  const dsrN1 = deflatedSharpeRatio({ observedSharpe: perPeriodSharpe, returns: dailySeries, numTrials: 1, sharpeVarianceAcrossTrials: 0 }).deflatedSharpeRatio
  const varianceN14 = populationVariance([...REGISTRY_VARIANT_SHARPES_DAILY_RESAMPLED, perPeriodSharpe])
  const dsrN14 = deflatedSharpeRatio({ observedSharpe: perPeriodSharpe, returns: dailySeries, numTrials: 14, sharpeVarianceAcrossTrials: varianceN14 }).deflatedSharpeRatio

  const cpcvMedianSignAgrees = cpcvMedianSignAgreement(trades)

  return {
    e1PointEstimate: e1.pointEstimate,
    e1CiLower: e1.ciLower,
    e1CiUpper: e1.ciUpper,
    economicPowerCondition1,
    robustnessConditionHolds,
    e2Verdict,
    dsrN1,
    dsrN14,
    cpcvMedianSignAgrees,
  }
}
