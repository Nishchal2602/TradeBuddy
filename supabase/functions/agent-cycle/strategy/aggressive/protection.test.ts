import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import {
  aggressiveProtectionFor,
  clearsTradeabilityFloor,
  computeCostR,
  computePositionPnlR,
  computePriceR,
  nextGivebackFloor,
  rawGivebackFloor,
  shouldExecuteGivebackExit,
  TRADEABILITY_FLOOR_K,
} from './protection.ts'

// --- aggressiveProtectionFor: the floor-binding vs ATR-dominant cases ----

Deno.test('aggressiveProtectionFor: when the ATR term dominates, R:R is exactly 2R (2xATR stop, 4xATR target)', () => {
  // ATR30 = 0.60% -> stopDistance = 2*0.006 = 0.012 (1.2%, clears the 0.8% floor)
  // targetDistance = 4*0.006 = 0.024 (2.4%). Ratio = 0.024/0.012 = 2 exactly.
  const result = aggressiveProtectionFor(0.60)
  assertAlmostEquals(result.stopLossPct, 0.012, 1e-12)
  assertAlmostEquals(result.takeProfitPct, 0.024, 1e-12)
  assertAlmostEquals(result.takeProfitPct / result.stopLossPct, 2, 1e-12)
})

Deno.test('aggressiveProtectionFor: exactly at the floor boundary (ATR30=0.40% -> 2xATR=0.8%=floor)', () => {
  const result = aggressiveProtectionFor(0.40)
  assertAlmostEquals(result.stopLossPct, 0.008, 1e-12)
  assertAlmostEquals(result.takeProfitPct, 0.016, 1e-12)
})

Deno.test('aggressiveProtectionFor: when the 0.8% floor binds, R:R is NOT 2R — stated honestly, not silently rounded', () => {
  // ATR30 = 0.20% -> 2xATR = 0.004 (0.4%), floored to 0.008 (0.8%).
  // targetDistance = 4*0.002 = 0.008 (0.8%). Ratio = 0.008/0.008 = 1, not 2.
  const result = aggressiveProtectionFor(0.20)
  assertAlmostEquals(result.stopLossPct, 0.008, 1e-12) // floor, not 2xATR
  assertAlmostEquals(result.takeProfitPct, 0.008, 1e-12) // still a pure 4xATR figure
  assertEquals(result.takeProfitPct / result.stopLossPct === 2, false, 'R:R must NOT be claimed as a constant 2R when the floor binds')
})

Deno.test('aggressiveProtectionFor: atrTargetDistancePct is exactly the same number as takeProfitPct — one quantity, two names for two roles', () => {
  const result = aggressiveProtectionFor(0.55)
  assertEquals(result.atrTargetDistancePct, result.takeProfitPct)
})

// --- Tradeability floor: K=3 -----------------------------------------------

Deno.test('TRADEABILITY_FLOOR_K is 3, pre-registered', () => {
  assertEquals(TRADEABILITY_FLOOR_K, 3)
})

Deno.test('clearsTradeabilityFloor: passes in typical BTC 30m volatility (ATR30 ~0.4%, well above the ~0.225% minimum)', () => {
  const protection = aggressiveProtectionFor(0.40) // target = 1.6%
  const cost = 0.003 // 0.30% round trip, as a fraction
  assertEquals(clearsTradeabilityFloor(protection.atrTargetDistancePct, cost), true)
})

Deno.test('clearsTradeabilityFloor: fails in a genuinely dead-quiet regime (ATR30=0.10% -> target 0.40%, cost 0.30% -> needs 0.90%)', () => {
  const protection = aggressiveProtectionFor(0.10) // target = 0.004 (0.4%)
  const cost = 0.003
  assertEquals(clearsTradeabilityFloor(protection.atrTargetDistancePct, cost), false)
})

Deno.test('clearsTradeabilityFloor: exactly at the boundary (target == 3x cost) passes — inclusive', () => {
  const cost = 0.003
  assertEquals(clearsTradeabilityFloor(TRADEABILITY_FLOOR_K * cost, cost), true)
})

Deno.test('clearsTradeabilityFloor: the documented minimum ATR30 (0.225%) is exactly the pass/fail boundary at K=3, cost=0.30%', () => {
  // target = 4 * (0.225/100) = 0.009 = 3 * 0.003 exactly.
  const protection = aggressiveProtectionFor(0.225)
  assertEquals(clearsTradeabilityFloor(protection.atrTargetDistancePct, 0.003), true)
  const justBelow = aggressiveProtectionFor(0.224)
  assertEquals(clearsTradeabilityFloor(justBelow.atrTargetDistancePct, 0.003), false)
})

// --- computePriceR / computePositionPnlR: the two metrics, never conflated
// (migration plan §3.1) -----------------------------------------------------

Deno.test('computePriceR: +1R is price exactly one riskPerUnit0 above the original entry (long)', () => {
  assertAlmostEquals(computePriceR(102, 100, 98, 'long'), 1, 1e-12)
})

Deno.test('computePriceR: symmetric for a short — price BELOW entry is positive R', () => {
  assertAlmostEquals(computePriceR(98, 100, 102, 'short'), 1, 1e-12)
})

Deno.test('computePriceR: zero riskPerUnit0 (degenerate ruler) returns 0 rather than dividing by zero', () => {
  assertEquals(computePriceR(105, 100, 100, 'long'), 0)
})

Deno.test('computePositionPnlR: +1R is unrealizedPnl exactly equal to initialRiskUsd, no partial realization', () => {
  assertAlmostEquals(computePositionPnlR(50, 0, 50), 1, 1e-12)
})

Deno.test('computePositionPnlR: negative P&L produces a negative R, not clamped to zero', () => {
  assertAlmostEquals(computePositionPnlR(-25, 0, 50), -0.5, 1e-12)
})

Deno.test('computePositionPnlR: partialRealizedPnlUsd adds directly into the numerator', () => {
  assertAlmostEquals(computePositionPnlR(20, 30, 50), 1, 1e-12) // (20+30)/50
})

Deno.test('computePositionPnlR: a non-positive initialRiskUsd returns 0 rather than dividing by zero or a negative', () => {
  assertEquals(computePositionPnlR(100, 0, 0), 0)
  assertEquals(computePositionPnlR(100, 0, -10), 0)
})

// The exact case from plan review that caught a real error in an earlier
// draft (which defined R purely from price displacement and called it
// profit): after an ADD at a worse price, priceR can be positive while
// positionPnlR is negative. This is the state a single conflated "R"
// would hide — asserted together, deliberately.
Deno.test('the two metrics diverge after an ADD at a worse price: priceR positive, positionPnlR negative', () => {
  // 1 unit @ entry 100, stop 98 (riskPerUnit0 = 2, initialRiskUsd = 2).
  // Price -> 104, ADD 2 units @ 104 (weighted-average entry becomes
  // (1*100 + 2*104)/3 = 102.6667). Price -> 102.50.
  const initialEntryPrice = 100
  const initialStopLossPrice = 98
  const initialRiskUsd = 1 * Math.abs(initialEntryPrice - initialStopLossPrice) // 2
  const newQuantity = 1 + 2
  const newEntryPrice = (1 * 100 + 2 * 104) / newQuantity
  const currentPrice = 102.50

  const priceR = computePriceR(currentPrice, initialEntryPrice, initialStopLossPrice, 'long')
  assertAlmostEquals(priceR, 1.25, 1e-9)

  const unrealizedPnlUsd = (currentPrice - newEntryPrice) * newQuantity
  const positionPnlR = computePositionPnlR(unrealizedPnlUsd, 0, initialRiskUsd)
  assertEquals(positionPnlR < 0, true, 'the position is genuinely losing money despite price sitting +1.25R above the original entry')
  assertAlmostEquals(positionPnlR, -0.25, 1e-9)
})

Deno.test('positionPnlR is continuous across an ADD executed at market — adding adds zero instantaneous P&L', () => {
  const oldQty = 1
  const oldEntry = 100
  const initialRiskUsd = 2
  const fillPrice = 104 // also the current price, i.e. the ADD executes at market
  const before = computePositionPnlR((fillPrice - oldEntry) * oldQty, 0, initialRiskUsd)

  const addQty = 2
  const newQty = oldQty + addQty
  const newEntry = (oldQty * oldEntry + addQty * fillPrice) / newQty
  const after = computePositionPnlR((fillPrice - newEntry) * newQty, 0, initialRiskUsd)

  assertAlmostEquals(after, before, 1e-9)
})

Deno.test('positionPnlR is continuous across a REDUCE executed at market — ONLY because the numerator includes partialRealizedPnlUsd', () => {
  const qtyBefore = 3
  const entry = 100
  const initialRiskUsd = 2
  const price = 106
  const unrealizedBefore = (price - entry) * qtyBefore
  const before = computePositionPnlR(unrealizedBefore, 0, initialRiskUsd)

  const reduceQty = 1
  const qtyAfter = qtyBefore - reduceQty
  const realizedThisReduce = (price - entry) * reduceQty // reducePosition's own formula, no slippage
  const unrealizedAfter = (price - entry) * qtyAfter

  const afterWithTerm = computePositionPnlR(unrealizedAfter, realizedThisReduce, initialRiskUsd)
  assertAlmostEquals(afterWithTerm, before, 1e-9, 'WITH partialRealizedPnlUsd accumulated, a deliberate harvest must not move positionPnlR')

  const afterWithoutTerm = computePositionPnlR(unrealizedAfter, 0, initialRiskUsd)
  assertEquals(afterWithoutTerm === before, false, 'WITHOUT the term, positionPnlR would crater at the instant of the reduce and misreport a harvest as giveback — pinning why partialRealizedPnlUsd exists')
})

// --- computeCostR: numerator tracks CURRENT quantity, denominator stays
// the immutable ruler ------------------------------------------------------

Deno.test('computeCostR: cost as a fraction of the immutable initial risk', () => {
  assertAlmostEquals(computeCostR(0.75, 2), 0.375, 1e-12) // matches the 0.30%-round-trip / 0.8%-stop-floor worked example
})

Deno.test('computeCostR: a larger CURRENT round-trip cost after an ADD produces a larger costR against the SAME immutable denominator', () => {
  const smaller = computeCostR(0.75, 2)
  const larger = computeCostR(1.50, 2) // position doubled by an ADD -> costs ~2x to round-trip
  assertEquals(larger > smaller, true)
})

// --- The giveback ratchet: rawGivebackFloor / nextGivebackFloor /
// shouldExecuteGivebackExit (migration plan §5.1) --------------------------

const COST_R = 0.375 // a representative costR, e.g. computeCostR(0.75, 2)

Deno.test('rawGivebackFloor: unarmed below +1R', () => {
  assertEquals(rawGivebackFloor(0.99, COST_R), null)
})

Deno.test('rawGivebackFloor: each rung arms at its exact boundary (inclusive)', () => {
  assertAlmostEquals(rawGivebackFloor(1.0, COST_R)!, COST_R, 1e-12)
  assertAlmostEquals(rawGivebackFloor(1.5, COST_R)!, 0.5, 1e-12)
  assertAlmostEquals(rawGivebackFloor(2.0, COST_R)!, 1.0, 1e-12)
  assertAlmostEquals(rawGivebackFloor(3.0, COST_R)!, 1.5, 1e-12)
})

Deno.test('rawGivebackFloor: between rungs uses the lower (already-reached) rung, not interpolated', () => {
  assertAlmostEquals(rawGivebackFloor(1.9, COST_R)!, 0.5, 1e-12) // last reached rung was 1.5
  assertAlmostEquals(rawGivebackFloor(2.9, COST_R)!, 1.0, 1e-12) // last reached rung was 2.0
})

Deno.test('nextGivebackFloor: unarmed -> armed', () => {
  assertAlmostEquals(nextGivebackFloor(1.0, COST_R, null)!, COST_R, 1e-12)
})

Deno.test('nextGivebackFloor: floor never decreases after sampledMfeR declines', () => {
  const armedAtTwoR = nextGivebackFloor(2.0, COST_R, null) // 1.0
  // sampledMfeR itself should never decline in practice (it is a running
  // max) — this asserts the ratchet defends against it anyway, as a
  // second, independent layer of monotonicity beyond "the input is
  // supposed to be monotone."
  const afterApparentDecline = nextGivebackFloor(1.2, COST_R, armedAtTwoR) // raw floor for 1.2R is only costR
  assertAlmostEquals(afterApparentDecline!, armedAtTwoR!, 1e-12)
})

Deno.test('nextGivebackFloor: a genuine rise past the next rung raises the floor', () => {
  const armedAtOneR = nextGivebackFloor(1.0, COST_R, null) // costR
  const armedAtTwoR = nextGivebackFloor(2.0, COST_R, armedAtOneR) // 1.0, strictly higher
  assertEquals(armedAtTwoR! > armedAtOneR!, true)
  assertAlmostEquals(armedAtTwoR!, 1.0, 1e-12)
})

Deno.test('nextGivebackFloor: never un-arms — an apparent drop back below +1R still returns the previously stored floor', () => {
  const armed = nextGivebackFloor(1.5, COST_R, null) // 0.5
  const stillArmed = nextGivebackFloor(0.2, COST_R, armed) // raw floor for 0.2R is null (unarmed)
  assertAlmostEquals(stillArmed!, armed!, 1e-12)
})

Deno.test('shouldExecuteGivebackExit: unarmed (null floor) never exits, regardless of positionPnlR', () => {
  assertEquals(shouldExecuteGivebackExit(-5, null), false)
  assertEquals(shouldExecuteGivebackExit(5, null), false)
})

Deno.test('shouldExecuteGivebackExit: armed, exits when positionPnlR retraces to or below the floor — boundary inclusive', () => {
  assertEquals(shouldExecuteGivebackExit(0.5, 0.5), true)
  assertEquals(shouldExecuteGivebackExit(0.49, 0.5), true)
  assertEquals(shouldExecuteGivebackExit(0.51, 0.5), false)
})

Deno.test('shouldExecuteGivebackExit: a small normal pullback below +1R never exits (unarmed) — no premature exit', () => {
  const floor = nextGivebackFloor(0.6, COST_R, null) // still unarmed, below the +1R threshold
  assertEquals(floor, null)
  assertEquals(shouldExecuteGivebackExit(0.4, floor), false)
})

Deno.test('shouldExecuteGivebackExit: continued momentum after a large MFE does not exit — the ratchet only rises, it does not force an exit on its own', () => {
  const floor = nextGivebackFloor(3.5, COST_R, null) // armed at 1.5
  assertEquals(shouldExecuteGivebackExit(3.2, floor), false) // still well above the floor
})
