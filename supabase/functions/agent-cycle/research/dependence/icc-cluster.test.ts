import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import { buildOverlapClusters, computeIccNEff, iccInterval } from './icc-cluster.ts'
import type { TradeObservation } from './icc-cluster.ts'

function trade(openedAt: string, closedAt: string, r: number): TradeObservation {
  return { openedAt, closedAt, r }
}

// --- buildOverlapClusters ---------------------------------------------

Deno.test('buildOverlapClusters: two disjoint trades (no overlap) form two separate clusters', () => {
  const trades = [trade('2020-01-01', '2020-01-05', 1), trade('2020-02-01', '2020-02-05', 2)]
  const clusters = buildOverlapClusters(trades)
  assertEquals(clusters.length, 2)
})

Deno.test('buildOverlapClusters: two directly overlapping trades form one cluster', () => {
  const trades = [trade('2020-01-01', '2020-01-10', 1), trade('2020-01-05', '2020-01-15', 2)]
  const clusters = buildOverlapClusters(trades)
  assertEquals(clusters.length, 1)
  assertEquals(clusters[0]!.trades.length, 2)
})

Deno.test('buildOverlapClusters: transitive overlap (A-B overlap, B-C overlap, A-C do NOT directly overlap) merges all three', () => {
  const a = trade('2020-01-01', '2020-01-10', 1)
  const b = trade('2020-01-08', '2020-01-20', 2) // overlaps A (08 <= 10)
  const c = trade('2020-01-18', '2020-01-30', 3) // overlaps B (18 <= 20), NOT A directly (18 > 10)
  const clusters = buildOverlapClusters([c, a, b]) // deliberately unsorted input
  assertEquals(clusters.length, 1)
  assertEquals(clusters[0]!.trades.length, 3)
})

Deno.test('buildOverlapClusters: entered in different months but held open concurrently -- still one cluster (contemporaneous exposure, not entry-month)', () => {
  const trades = [trade('2020-01-28', '2020-02-15', 1), trade('2020-02-05', '2020-02-20', 2)]
  const clusters = buildOverlapClusters(trades)
  assertEquals(clusters.length, 1)
})

Deno.test('buildOverlapClusters: a boundary touch (one closes exactly when the next opens) counts as overlapping', () => {
  const trades = [trade('2020-01-01', '2020-01-10', 1), trade('2020-01-10', '2020-01-20', 2)]
  assertEquals(buildOverlapClusters(trades).length, 1)
})

Deno.test('buildOverlapClusters: empty input produces no clusters', () => {
  assertEquals(buildOverlapClusters([]), [])
})

// --- computeIccNEff -- hand-computable example --------------------------
//
// Two clusters of 2 trades each (constructed so they do NOT overlap each
// other, confirmed via buildOverlapClusters' own semantics above):
//   cluster 1: r = [1, 3], mean 2
//   cluster 2: r = [5, 7], mean 6
// grand mean = 4, k=2, n=4, cluster sizes [2,2]
//   SSB = 2*(2-4)^2 + 2*(6-4)^2 = 16         MSB = 16/(2-1) = 16
//   SSW = (1-2)^2+(3-2)^2+(5-6)^2+(7-6)^2 = 4 MSW = 4/(4-2) = 2
//   sumM2 = 8, m0 = (1/(2-1))*(4 - 8/4) = 2
//   ICC = (16-2)/(16+(2-1)*2) = 14/18 = 0.777778
//   mA = 8/4 = 2, DEFF = 1+(2-1)*0.777778 = 1.777778
//   n_eff = 4/1.777778 = 2.25 exactly

Deno.test('computeIccNEff: matches a hand-computed two-cluster ANOVA example exactly', () => {
  const trades = [
    trade('2020-01-01', '2020-01-10', 1),
    trade('2020-01-05', '2020-01-15', 3), // same cluster as above (overlaps)
    trade('2020-02-01', '2020-02-10', 5),
    trade('2020-02-05', '2020-02-15', 7), // same cluster as above (overlaps), disjoint from the first pair
  ]
  const result = computeIccNEff(trades)
  assertEquals(result.n, 4)
  assertEquals(result.k, 2)
  assertAlmostEquals(result.mA, 2, 1e-9)
  assertAlmostEquals(result.rhoIntraRaw, 14 / 18, 1e-9)
  assertAlmostEquals(result.rhoIntra, 14 / 18, 1e-9)
  assertAlmostEquals(result.deff, 16 / 9, 1e-9) // 1 + 1*(14/18) = 32/18 = 16/9
  assertAlmostEquals(result.nEff, 2.25, 1e-9)
})

Deno.test('computeIccNEff: n_eff never exceeds raw N, even in a degenerate/negative-ICC case', () => {
  // All trades disjoint (each its own cluster, k===n) -- the degenerate
  // "no evidence of dependence" path.
  const trades = [trade('2020-01-01', '2020-01-02', 1), trade('2020-02-01', '2020-02-02', -1), trade('2020-03-01', '2020-03-02', 2)]
  const result = computeIccNEff(trades)
  assertEquals(result.k, result.n)
  assertEquals(result.rhoIntra, 0)
  assertEquals(result.nEff, result.n)
})

Deno.test('computeIccNEff: a single cluster (k=1, everything overlaps) falls back to the degenerate "no evidence" case, never NaN', () => {
  const trades = [trade('2020-01-01', '2020-06-01', 1), trade('2020-01-15', '2020-06-15', 2), trade('2020-02-01', '2020-07-01', 3)]
  const result = computeIccNEff(trades)
  assertEquals(result.k, 1)
  assertEquals(result.rhoIntra, 0)
  assertEquals(result.nEff, result.n)
  assertEquals(Number.isNaN(result.nEff), false)
})

Deno.test('computeIccNEff: empty input returns n=0 without throwing', () => {
  const result = computeIccNEff([])
  assertEquals(result.n, 0)
  assertEquals(result.nEff, 0)
})

Deno.test('computeIccNEff: a negative raw ICC (between-cluster variance smaller than within) is floored at zero, not reported negative', () => {
  // Construct clusters where within-cluster spread exceeds between-cluster
  // spread -- e.g. alternating high/low values inside each cluster, with
  // cluster means close to each other.
  const trades = [
    trade('2020-01-01', '2020-01-10', 10),
    trade('2020-01-05', '2020-01-15', -8), // cluster 1: mean 1
    trade('2020-02-01', '2020-02-10', -9),
    trade('2020-02-05', '2020-02-15', 11), // cluster 2: mean 1 (same as cluster 1 -> between-variance ~0)
  ]
  const result = computeIccNEff(trades)
  if (result.rhoIntraRaw >= 0) throw new Error(`expected a negative raw ICC in this construction, got ${result.rhoIntraRaw}`)
  assertEquals(result.rhoIntra, 0)
  assertEquals(result.nEff, result.n) // DEFF=1 when rhoIntra floored to 0
})

// --- iccInterval ---------------------------------------------------------

Deno.test('iccInterval: point estimate is the plain pooled mean, regardless of clustering', () => {
  const trades = [trade('2020-01-01', '2020-01-02', 1), trade('2020-02-01', '2020-02-02', 2), trade('2020-03-01', '2020-03-02', 3)]
  const interval = iccInterval(trades)
  assertAlmostEquals(interval.pointEstimate, 2, 1e-9)
})

Deno.test('iccInterval: heavier clustering (lower n_eff) widens the interval relative to the disjoint case, for the same raw data spread', () => {
  const disjoint = [trade('2020-01-01', '2020-01-02', 1), trade('2020-02-01', '2020-02-02', 3), trade('2020-03-01', '2020-03-02', 5), trade('2020-04-01', '2020-04-02', 7)]
  const clustered = [
    trade('2020-01-01', '2020-01-10', 1),
    trade('2020-01-05', '2020-01-15', 3),
    trade('2020-02-01', '2020-02-10', 5),
    trade('2020-02-05', '2020-02-15', 7),
  ]
  const disjointInterval = iccInterval(disjoint)
  const clusteredInterval = iccInterval(clustered)
  const disjointWidth = disjointInterval.ciUpper - disjointInterval.ciLower
  const clusteredWidth = clusteredInterval.ciUpper - clusteredInterval.ciLower
  if (!(clusteredWidth > disjointWidth)) throw new Error(`expected clustered width (${clusteredWidth}) > disjoint width (${disjointWidth})`)
})
