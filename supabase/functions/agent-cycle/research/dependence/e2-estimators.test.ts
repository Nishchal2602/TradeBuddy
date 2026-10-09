import { assertEquals } from 'jsr:@std/assert@1'
import { combineE2Directions, computeE2, directionOf } from './e2-estimators.ts'
import type { Direction, TradeObservation } from './e2-estimators.ts'

// --- directionOf ----------------------------------------------------------

Deno.test('directionOf: an interval entirely above zero is positive', () => {
  assertEquals(directionOf({ ciLower: 0.5, ciUpper: 1.5 }), 'positive')
})

Deno.test('directionOf: an interval entirely below zero is negative', () => {
  assertEquals(directionOf({ ciLower: -1.5, ciUpper: -0.5 }), 'negative')
})

Deno.test('directionOf: an interval spanning zero is null (not significant)', () => {
  assertEquals(directionOf({ ciLower: -0.2, ciUpper: 0.4 }), null)
})

Deno.test('directionOf: a boundary touching exactly zero is null (strict exclusion required)', () => {
  assertEquals(directionOf({ ciLower: 0, ciUpper: 1 }), null)
  assertEquals(directionOf({ ciLower: -1, ciUpper: 0 }), null)
})

// --- combineE2Directions — the generalized tie-break rule -----------------

Deno.test('combineE2Directions: all three positive -> significant, positive', () => {
  assertEquals(combineE2Directions(['positive', 'positive', 'positive']), { kind: 'significant', direction: 'positive' })
})

Deno.test('combineE2Directions: all three negative -> significant, negative', () => {
  assertEquals(combineE2Directions(['negative', 'negative', 'negative']), { kind: 'significant', direction: 'negative' })
})

Deno.test('combineE2Directions: any one null (includes zero) -> not significant, regardless of the other two', () => {
  const cases: [Direction, Direction, Direction][] = [
    ['positive', 'positive', null],
    [null, 'negative', 'negative'],
    ['positive', null, 'negative'], // even alongside a disagreement, a null still means "not significant"
    [null, null, null],
  ]
  for (const directions of cases) {
    assertEquals(combineE2Directions(directions), { kind: 'not_significant' })
  }
})

Deno.test('combineE2Directions: two agree, one disagrees (both non-null) -> estimator conflict, never resolved by majority', () => {
  assertEquals(combineE2Directions(['positive', 'positive', 'negative']), { kind: 'estimator_conflict' })
  assertEquals(combineE2Directions(['negative', 'negative', 'positive']), { kind: 'estimator_conflict' })
})

Deno.test('combineE2Directions: one positive, one negative, one null -> still not_significant (null dominates, never conflict)', () => {
  assertEquals(combineE2Directions(['positive', 'negative', null]), { kind: 'not_significant' })
})

// --- computeE2 — integration, qualitative checks -------------------------

function trade(openedAt: string, closedAt: string, r: number): TradeObservation {
  return { openedAt, closedAt, r }
}

// Deterministic PRNG so the bootstrap component of this integration test
// is reproducible.
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

Deno.test('computeE2: a strongly, consistently positive trade population resolves significant/positive across all three estimators', () => {
  const trades: TradeObservation[] = []
  for (let m = 1; m <= 24; m++) {
    const month = String(m).padStart(2, '0')
    // Several well-separated positive trades per month, non-overlapping
    // holding periods, so the ICC estimator sees many small clusters
    // rather than one giant one.
    for (let d = 1; d <= 3; d++) {
      const day = String(d * 5).padStart(2, '0')
      trades.push(trade(`2020-${month}-${day}T00:00:00Z`, `2020-${month}-${day}T06:00:00Z`, 1.5 + (d % 2 === 0 ? 0.3 : -0.1)))
    }
  }
  const result = computeE2(trades, { fromMonth: '2020-01', toMonth: '2020-12', numResamples: 500, rng: mulberry32(1) })
  assertEquals(result.n, trades.length)
  assertEquals(result.icc.pointEstimate > 0, true)
  assertEquals(result.neweyWest.pointEstimate > 0, true)
  assertEquals(result.blockBootstrap.pointEstimate > 0, true)
  assertEquals(result.verdict.kind, 'significant')
  if (result.verdict.kind === 'significant') assertEquals(result.verdict.direction, 'positive')
})

Deno.test('computeE2: a population centered near zero with real spread is not significant', () => {
  const trades: TradeObservation[] = []
  let sign = 1
  for (let m = 1; m <= 24; m++) {
    const month = String(m).padStart(2, '0')
    trades.push(trade(`2020-${month}-05T00:00:00Z`, `2020-${month}-05T06:00:00Z`, 0.3 * sign))
    trades.push(trade(`2020-${month}-15T00:00:00Z`, `2020-${month}-15T06:00:00Z`, -0.3 * sign))
    sign *= -1
  }
  const result = computeE2(trades, { fromMonth: '2020-01', toMonth: '2020-12', numResamples: 500, rng: mulberry32(2) })
  assertEquals(result.verdict.kind, 'not_significant')
})

Deno.test('computeE2: reports all three estimators unconditionally, even when the verdict is a single word', () => {
  const trades: TradeObservation[] = [trade('2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z', 1), trade('2020-02-01T00:00:00Z', '2020-02-02T00:00:00Z', 2)]
  const result = computeE2(trades, { fromMonth: '2020-01', toMonth: '2020-02', numResamples: 200, rng: mulberry32(3) })
  // All three sub-results must be present and well-formed regardless of
  // the verdict -- Stage A's own "all three reported regardless of which
  // branch applies" requirement.
  assertEquals(typeof result.icc.pointEstimate, 'number')
  assertEquals(typeof result.neweyWest.pointEstimate, 'number')
  assertEquals(typeof result.blockBootstrap.pointEstimate, 'number')
})
