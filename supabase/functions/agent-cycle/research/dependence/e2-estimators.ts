// DT-1 (2026-10-09) — E2's three-estimator orchestration and the
// generalized direction-disagreement tie-break (plan §6.4c3, Stage A
// §4): "significant only if all three E2 intervals exclude zero in the
// same direction; any interval including zero -> not significant; two
// excluding zero in opposite directions -> 'estimator conflict,'
// reported as its own finding, never resolved by majority." Applies to
// E2 ONLY -- E1 has a single interval method (the block bootstrap alone)
// and needs no tie-break at all.

import { computeIccNEff, iccInterval } from './icc-cluster.ts'
import type { TradeObservation as IccTradeObservation } from './icc-cluster.ts'
import { buildMonthlySeries, computeNeweyWestE2 } from './newey-west.ts'
import type { TradeObservation as NwTradeObservation } from './newey-west.ts'
import { politisWhiteBlockLength, stationaryBootstrapCI } from './block-bootstrap.ts'

export interface TradeObservation {
  openedAt: string
  closedAt: string
  r: number
}

export interface EstimatorInterval {
  pointEstimate: number
  ciLower: number
  ciUpper: number
}

export type Direction = 'positive' | 'negative' | null

export function directionOf(interval: Pick<EstimatorInterval, 'ciLower' | 'ciUpper'>): Direction {
  if (interval.ciLower > 0) return 'positive'
  if (interval.ciUpper < 0) return 'negative'
  return null
}

export type E2Verdict =
  | { kind: 'significant'; direction: 'positive' | 'negative' }
  | { kind: 'not_significant' }
  | { kind: 'estimator_conflict' }

export function combineE2Directions(directions: readonly [Direction, Direction, Direction]): E2Verdict {
  if (directions.some((d) => d === null)) return { kind: 'not_significant' }
  if (directions.every((d) => d === 'positive')) return { kind: 'significant', direction: 'positive' }
  if (directions.every((d) => d === 'negative')) return { kind: 'significant', direction: 'negative' }
  return { kind: 'estimator_conflict' }
}

export interface E2Result {
  icc: EstimatorInterval & { nEff: number; rhoIntra: number; k: number }
  neweyWest: EstimatorInterval & { lag: number; t: number }
  blockBootstrap: EstimatorInterval & { meanBlockLength: number }
  verdict: E2Verdict
  n: number
}

export interface ComputeE2Options {
  fromMonth: string // YYYY-MM, inclusive
  toMonth: string // YYYY-MM, inclusive
  numResamples?: number
  rng?: () => number
}

// Runs all three estimators over the same pooled trade population and
// applies the tie-break. All three are ALWAYS computed and returned
// (Stage A §4: "all three E2 intervals... reported regardless of which
// branch applies") -- the verdict is a summary, never a replacement for
// seeing each estimator's own interval.
export function computeE2(trades: readonly TradeObservation[], opts: ComputeE2Options): E2Result {
  const n = trades.length
  const icc = iccInterval(trades as readonly IccTradeObservation[])
  const iccMeta = computeIccNEff(trades as readonly IccTradeObservation[])

  const monthly = buildMonthlySeries(trades as readonly NwTradeObservation[], opts.fromMonth, opts.toMonth)
  const nw = computeNeweyWestE2(monthly)

  const rs = trades.map((t) => t.r)
  const meanStatistic = (xs: readonly number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)
  const blockLength = politisWhiteBlockLength(rs)
  const bootstrap = stationaryBootstrapCI(rs, meanStatistic, {
    numResamples: opts.numResamples ?? 10_000,
    meanBlockLength: blockLength,
    rng: opts.rng,
  })

  const directions: [Direction, Direction, Direction] = [directionOf(icc), directionOf(nw), directionOf(bootstrap)]
  const verdict = combineE2Directions(directions)

  return {
    n,
    icc: { pointEstimate: icc.pointEstimate, ciLower: icc.ciLower, ciUpper: icc.ciUpper, nEff: iccMeta.nEff, rhoIntra: iccMeta.rhoIntra, k: iccMeta.k },
    neweyWest: { pointEstimate: nw.e2, ciLower: nw.ciLower, ciUpper: nw.ciUpper, lag: nw.lag, t: nw.t },
    blockBootstrap: { pointEstimate: bootstrap.pointEstimate, ciLower: bootstrap.ciLower, ciUpper: bootstrap.ciUpper, meanBlockLength: bootstrap.meanBlockLength },
    verdict,
  }
}
