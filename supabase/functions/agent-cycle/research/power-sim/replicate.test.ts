import { assertEquals } from 'jsr:@std/assert@1'
import { runOneReplicate } from './replicate.ts'
import type { MeasuredInputs } from './dgp.ts'

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

const SHAPE = Array.from({ length: 2000 }, (_, i) => {
  const u = (i + 0.5) / 2000
  return Math.log(u / (1 - u)) * 0.6
})

function fakeInputs(): MeasuredInputs {
  return {
    tradeMoments: {
      n: 352,
      mean: 0.17,
      sd: 2.92,
      skewness: 1.15,
      excessKurtosis: 0.04,
      standardizedRValues: SHAPE,
      meanHoldingDays: 9.4,
      medianHoldingDays: 4,
      holdingDaysValues: [1, 2, 3, 4, 5, 7, 10, 14, 20, 30],
    },
    perSleeveDailyVolatility: { medianLogReturnSd: 0.064, assetsSampled: 90 },
  }
}

function monthlyTrajectory(numMonths: number, n: number): Map<string, number> {
  const m = new Map<string, number>()
  for (let i = 0; i < numMonths; i++) m.set(`${2018 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, n)
  return m
}

Deno.test('runOneReplicate: produces a well-formed result for a modest scenario, never throws', () => {
  const rng = mulberry32(1)
  const result = runOneReplicate({
    scenario: { rhoBar: 0.5, trueAnnualizedSharpe: 0.5 },
    measuredInputs: fakeInputs(),
    nTrajectoryByDay: new Array(1000).fill(20),
    nTrajectoryByMonth: monthlyTrajectory(30, 20),
    fromMonth: '2018-01',
    toMonth: '2020-06',
    tradesPerSleevePerMonth: 1.7,
    matureN: 20,
    bootstrapResamples: 200,
    rng,
  })
  assertEquals(typeof result.e1PointEstimate, 'number')
  assertEquals(typeof result.economicPowerCondition1, 'boolean')
  assertEquals(result.e1CiLower <= result.e1PointEstimate && result.e1PointEstimate <= result.e1CiUpper, true)
})

Deno.test('runOneReplicate: a very high true Sharpe with ample data clears the economic power bar far more often than a zero true Sharpe', () => {
  const trueSharpeHighResults: boolean[] = []
  const trueSharpeZeroResults: boolean[] = []
  for (let seed = 1; seed <= 15; seed++) {
    const high = runOneReplicate({
      scenario: { rhoBar: 0.5, trueAnnualizedSharpe: 2.0 },
      measuredInputs: fakeInputs(),
      nTrajectoryByDay: new Array(3136).fill(20),
      nTrajectoryByMonth: monthlyTrajectory(103, 20),
      fromMonth: '2018-03',
      toMonth: '2026-09',
      tradesPerSleevePerMonth: 1.7,
      matureN: 20,
      bootstrapResamples: 150,
      rng: mulberry32(seed),
    })
    trueSharpeHighResults.push(high.economicPowerCondition1)

    const zero = runOneReplicate({
      scenario: { rhoBar: 0.5, trueAnnualizedSharpe: 0 },
      measuredInputs: fakeInputs(),
      nTrajectoryByDay: new Array(3136).fill(20),
      nTrajectoryByMonth: monthlyTrajectory(103, 20),
      fromMonth: '2018-03',
      toMonth: '2026-09',
      tradesPerSleevePerMonth: 1.7,
      matureN: 20,
      bootstrapResamples: 150,
      rng: mulberry32(seed + 1000),
    })
    trueSharpeZeroResults.push(zero.economicPowerCondition1)
  }
  const highRate = trueSharpeHighResults.filter(Boolean).length / trueSharpeHighResults.length
  const zeroRate = trueSharpeZeroResults.filter(Boolean).length / trueSharpeZeroResults.length
  if (!(highRate > zeroRate)) throw new Error(`expected high-Sharpe power rate (${highRate}) > zero-Sharpe rate (${zeroRate})`)
  assertEquals(zeroRate, 0) // a true Sharpe of 0 should essentially never clear a 0.54 bar
})

Deno.test('runOneReplicate: reports null (not a forced true/false) for robustness and CPCV when there is not enough data to compute them', () => {
  const rng = mulberry32(42)
  const result = runOneReplicate({
    scenario: { rhoBar: 0.5, trueAnnualizedSharpe: 0.5 },
    measuredInputs: fakeInputs(),
    nTrajectoryByDay: new Array(100).fill(2), // under a year -- robustness needs 2+ years
    nTrajectoryByMonth: monthlyTrajectory(1, 1), // ~1.7 expected trades total -- comfortably under CPCV's 10-trade floor
    fromMonth: '2018-01',
    toMonth: '2018-03',
    tradesPerSleevePerMonth: 1.7,
    matureN: 20,
    bootstrapResamples: 100,
    rng,
  })
  assertEquals(result.robustnessConditionHolds, null)
  assertEquals(result.cpcvMedianSignAgrees, null)
})
