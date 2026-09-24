import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import { addToPosition, applySlippage, closePosition, computeNav, computePositionValue, openPosition, reducePosition } from './accounting.ts'
import { ACCOUNTING_SCENARIOS } from '../domain/contract.fixtures.ts'
import type { Position } from '../../../../src/shared/positions/types.ts'

const PORTFOLIO_ID = '11111111-1111-1111-1111-111111111111'
const OPEN_DECISION_ID = '22222222-2222-2222-2222-222222222222'
const CLOSE_DECISION_ID = '33333333-3333-3333-3333-333333333333'
const T0 = '2026-09-18T00:00:00.000Z'
const T1 = '2026-09-18T06:00:00.000Z'

// --- Step 0 fixture reproduction: the primary correctness proof ---------
//
// Every one of Step 0's 6 ACCOUNTING_SCENARIOS is replayed end to end
// through the real openPosition/closePosition functions, with
// slippageBps=0 so entryPrice/fillPrice in the fixtures are exactly what
// gets used (the fixtures never modeled slippage — see the module comment
// below on why that's a deliberate scope boundary, not a gap). This is
// the single most important test in this file: it proves Step 4 satisfies
// Step 0's contract, not just that some numbers I invented happen to work.

Deno.test('accounting: every Step 0 ACCOUNTING_SCENARIOS fixture reproduces exactly, agent-initiated close', () => {
  for (const scenario of ACCOUNTING_SCENARIOS) {
    const feeBps = scenario.feeRate * 10_000

    const opened = openPosition({
      asset: 'BTC',
      direction: scenario.direction,
      referencePrice: scenario.entryPrice,
      notionalUsd: scenario.notional,
      stopLossPrice: scenario.direction === 'long' ? scenario.entryPrice * 0.5 : scenario.entryPrice * 1.5,
      takeProfitPrice: scenario.direction === 'long' ? scenario.entryPrice * 1.5 : scenario.entryPrice * 0.5,
      feeBps,
      slippageBps: 0,
      portfolioId: PORTFOLIO_ID,
      decisionId: OPEN_DECISION_ID,
      startingCash: scenario.startingCash,
      nowIso: T0,
    })

    assertAlmostEquals(opened.position.quantity, scenario.expected.quantity, 1e-9, `${scenario.name}: quantity`)
    assertAlmostEquals(opened.trade.fee, scenario.expected.feeOpen, 1e-9, `${scenario.name}: feeOpen`)
    assertAlmostEquals(opened.cashAfter, scenario.expected.cashAfterOpen, 1e-9, `${scenario.name}: cashAfterOpen`)
    assertAlmostEquals(opened.position.costBasis, scenario.expected.costBasis, 1e-9, `${scenario.name}: costBasis`)

    const attemptedFillPrice = scenario.observedPrice ?? scenario.fillPrice
    const closed = closePosition({
      position: opened.position,
      attemptedFillPrice,
      feeBps,
      slippageBps: 0,
      closeReason: 'agent_close',
      decisionId: CLOSE_DECISION_ID, // agent-initiated for this pass
      startingCash: opened.cashAfter,
      nowIso: T1,
    })

    assertAlmostEquals(closed.trade.fee, scenario.expected.feeClose, 1e-9, `${scenario.name}: feeClose`)
    assertAlmostEquals(closed.cashAfter, scenario.expected.cashAfterClose, 1e-9, `${scenario.name}: cashAfterClose`)
    assertAlmostEquals(closed.realizedPnl, scenario.expected.realizedPnl, 1e-9, `${scenario.name}: realizedPnl`)
  }
})

// --- Provenance divergence: the subtle case this module exists to get right ---

Deno.test('accounting: automatic exhaustion exit — both closeReason AND trigger_reason become collateral_exhausted', () => {
  const gapScenario = ACCOUNTING_SCENARIOS.find((s) => s.name.includes('GAP THROUGH'))!
  const opened = openPosition({
    asset: 'BTC', direction: 'short', referencePrice: gapScenario.entryPrice, notionalUsd: gapScenario.notional,
    stopLossPrice: gapScenario.entryPrice * 1.5, takeProfitPrice: gapScenario.entryPrice * 0.5,
    feeBps: gapScenario.feeRate * 10_000, slippageBps: 0,
    portfolioId: PORTFOLIO_ID, decisionId: OPEN_DECISION_ID, startingCash: gapScenario.startingCash, nowIso: T0,
  })

  const closed = closePosition({
    position: opened.position,
    attemptedFillPrice: gapScenario.observedPrice!,
    feeBps: gapScenario.feeRate * 10_000,
    slippageBps: 0,
    closeReason: 'stop_loss', // whatever the monitor thought triggered it
    decisionId: null, // automatic — no agent decision
    startingCash: opened.cashAfter,
    nowIso: T1,
  })

  assertEquals(closed.closedPosition.closeReason, 'collateral_exhausted')
  if (closed.trade.decisionId === null) {
    assertEquals(closed.trade.triggerReason, 'collateral_exhausted')
  }
})

Deno.test('accounting: agent-initiated close that happens to gap past exhaustion — positions.close_reason and trades.trigger_reason DIVERGE by design', () => {
  // The DB's trades_provenance_valid constraint (Step 1) requires
  // trigger_reason = 'agent_close' EXACTLY whenever decision_id is set —
  // no exception for exhaustion. Rare in practice (the monitor's 10-min
  // cadence should already have closed an exhausted position long before
  // the next 3h agent cycle), but handled correctly rather than assumed
  // impossible.
  const gapScenario = ACCOUNTING_SCENARIOS.find((s) => s.name.includes('GAP THROUGH'))!
  const opened = openPosition({
    asset: 'BTC', direction: 'short', referencePrice: gapScenario.entryPrice, notionalUsd: gapScenario.notional,
    stopLossPrice: gapScenario.entryPrice * 1.5, takeProfitPrice: gapScenario.entryPrice * 0.5,
    feeBps: gapScenario.feeRate * 10_000, slippageBps: 0,
    portfolioId: PORTFOLIO_ID, decisionId: OPEN_DECISION_ID, startingCash: gapScenario.startingCash, nowIso: T0,
  })

  const closed = closePosition({
    position: opened.position,
    attemptedFillPrice: gapScenario.observedPrice!, // price has already gapped past exhaustion
    feeBps: gapScenario.feeRate * 10_000,
    slippageBps: 0,
    closeReason: 'agent_close',
    decisionId: CLOSE_DECISION_ID, // an agent decision executed this close
    startingCash: opened.cashAfter,
    nowIso: T1,
  })

  // Accounting truth: the position really was exhaustion-closed.
  assertEquals(closed.closedPosition.closeReason, 'collateral_exhausted')
  // Provenance: this specific trade was still agent-initiated, and the DB
  // constraint requires the trade to say so regardless.
  assertEquals(closed.trade.decisionId, CLOSE_DECISION_ID)
  if (closed.trade.decisionId !== null) {
    assertEquals(closed.trade.triggerReason, 'agent_close')
  }
  // Both are still individually correct — the P&L reflects the clamped
  // exhaustion price either way.
  assertAlmostEquals(closed.realizedPnl, gapScenario.expected.realizedPnl, 1e-9)
})

// --- Long positions have no exhaustion ceiling ---------------------------

Deno.test('accounting: a long position never triggers the exhaustion clamp, even at a large loss', () => {
  const opened = openPosition({
    asset: 'BTC', direction: 'long', referencePrice: 100, notionalUsd: 2000,
    stopLossPrice: 1, takeProfitPrice: 200, // deliberately permissive bounds for this test
    feeBps: 10, slippageBps: 0, portfolioId: PORTFOLIO_ID, decisionId: OPEN_DECISION_ID,
    startingCash: 10000, nowIso: T0,
  })
  const closed = closePosition({
    position: opened.position,
    attemptedFillPrice: 5, // a 95% drawdown
    feeBps: 10, slippageBps: 0, closeReason: 'agent_close', decisionId: CLOSE_DECISION_ID,
    startingCash: opened.cashAfter, nowIso: T1,
  })
  assertEquals(closed.closedPosition.closeReason, 'agent_close') // NOT overridden — no such concept for longs
  assertAlmostEquals(closed.realizedPnl, (5 - 100) * 20, 1e-9) // the plain formula, no clamp
})

// --- Slippage -------------------------------------------------------------

Deno.test('applySlippage: BUY moves the fill price up, SELL moves it down, by exactly the stated bps', () => {
  assertAlmostEquals(applySlippage(200, 'BUY', 5), 200.1, 1e-9) // 0.05%
  assertAlmostEquals(applySlippage(200, 'SELL', 5), 199.9, 1e-9)
})

Deno.test('accounting: a full long round trip with real slippage matches an independently verified worked example', () => {
  // Fresh numbers, computed independently in Python before being
  // transcribed here (same discipline as every prior unit) — Step 0's own
  // fixtures never modeled slippage (entryPrice/fillPrice there ARE
  // already the fill prices), so this scenario exists specifically to
  // prove the slippage-adjustment layer Step 4 adds on top of Step 0's
  // proven formulas.
  const opened = openPosition({
    asset: 'BTC', direction: 'long', referencePrice: 200, notionalUsd: 4000,
    stopLossPrice: 150, takeProfitPrice: 250, feeBps: 10, slippageBps: 5,
    portfolioId: PORTFOLIO_ID, decisionId: OPEN_DECISION_ID, startingCash: 10000, nowIso: T0,
  })
  assertAlmostEquals(opened.position.entryPrice, 200.1, 1e-9)
  assertAlmostEquals(opened.position.quantity, 20, 1e-9)
  assertAlmostEquals(opened.cashAfter, 5993.998, 1e-6)

  const closed = closePosition({
    position: opened.position, attemptedFillPrice: 220, feeBps: 10, slippageBps: 5,
    closeReason: 'agent_close', decisionId: CLOSE_DECISION_ID, startingCash: opened.cashAfter, nowIso: T1,
  })
  assertAlmostEquals(closed.trade.fillPrice, 219.89, 1e-6)
  assertAlmostEquals(closed.realizedPnl, 395.8, 1e-6)
  assertAlmostEquals(closed.cashAfter, 10387.4002, 1e-4)

  // The identity that actually holds once slippage is nonzero: realizedPnl
  // is computed from FILL prices (post-slippage), so slippage cost is
  // already netted into it — subtracting a separate totalSlippage term on
  // top, the way Step 0's zero-slippage identity is worded, would
  // double-count it. Both forms coincide only when slippage is 0, which is
  // all Step 0's fixtures ever exercised. Caught by checking this
  // identity independently in Python before writing it here — see
  // progress-tracker.md.
  const totalFees = opened.trade.fee + closed.trade.fee
  assertAlmostEquals(closed.cashAfter - 10000, closed.realizedPnl - totalFees, 1e-6)
})

// --- Trade record shape ----------------------------------------------------

Deno.test('accounting: an OPEN trade has decisionId set and triggerReason null (matches trades_provenance_valid)', () => {
  const opened = openPosition({
    asset: 'ETH', direction: 'long', referencePrice: 2000, notionalUsd: 1000,
    stopLossPrice: 1900, takeProfitPrice: 2200, feeBps: 10, slippageBps: 5,
    portfolioId: PORTFOLIO_ID, decisionId: OPEN_DECISION_ID, startingCash: 10000, nowIso: T0,
  })
  assertEquals(opened.trade.intent, 'OPEN_LONG')
  assertEquals(opened.trade.decisionId, OPEN_DECISION_ID)
  assertEquals(opened.trade.triggerReason, null)
  assertEquals(opened.trade.side, 'BUY')
})

Deno.test('accounting: a SHORT open trade has side SELL, a SHORT close trade has side BUY', () => {
  const opened = openPosition({
    asset: 'ETH', direction: 'short', referencePrice: 2000, notionalUsd: 1000,
    stopLossPrice: 2200, takeProfitPrice: 1800, feeBps: 10, slippageBps: 0,
    portfolioId: PORTFOLIO_ID, decisionId: OPEN_DECISION_ID, startingCash: 10000, nowIso: T0,
  })
  assertEquals(opened.trade.side, 'SELL')
  assertEquals(opened.trade.intent, 'OPEN_SHORT')

  const closed = closePosition({
    position: opened.position, attemptedFillPrice: 1900, feeBps: 10, slippageBps: 0,
    closeReason: 'agent_close', decisionId: CLOSE_DECISION_ID, startingCash: opened.cashAfter, nowIso: T1,
  })
  assertEquals(closed.trade.side, 'BUY')
  assertEquals(closed.trade.intent, 'CLOSE_SHORT')
})

// --- NAV -----------------------------------------------------------------

Deno.test('computeNav: cash plus a long and a short position, matches an independently verified value', () => {
  const cash = 5000
  const longBtc = { direction: 'long' as const, quantity: 20, entryPrice: 100, costBasis: 2000, currentPrice: 110 }
  const shortEth = { direction: 'short' as const, quantity: 20, entryPrice: 100, costBasis: 2000, currentPrice: 90 }

  assertAlmostEquals(computePositionValue(longBtc), 2200, 1e-9)
  assertAlmostEquals(computePositionValue(shortEth), 2200, 1e-9)
  assertAlmostEquals(computeNav(cash, [longBtc, shortEth]), 9400, 1e-9)
})

Deno.test('computeNav: cash alone, with no open positions', () => {
  assertAlmostEquals(computeNav(7500, []), 7500, 1e-9)
})

Deno.test('computePositionValue: a short priced far past exhaustion is floored at 0, never negative', () => {
  const deepUnderwaterShort = { direction: 'short' as const, quantity: 20, entryPrice: 100, costBasis: 2000, currentPrice: 250 }
  assertEquals(computePositionValue(deepUnderwaterShort), 0)
})

Deno.test('computePositionValue: a long has no floor — its value simply tracks quantity times current price', () => {
  const long = { direction: 'long' as const, quantity: 20, entryPrice: 100, costBasis: 2000, currentPrice: 1 }
  assertAlmostEquals(computePositionValue(long), 20, 1e-9) // small but not artificially floored to anything else
})

// =========================================================================
// Phase 2 (2026-09-22) — addToPosition / reducePosition
//
// Every non-trivial number below was computed independently by hand
// before being transcribed here — same discipline as the Step 0 fixtures
// above. All positions in this section start from a real openPosition()
// call rather than a hand-typed literal, so the entryPrice/costBasis
// invariant (entryPrice === costBasis/quantity) these functions depend on
// is proven to hold from real broker output, not assumed.
// =========================================================================

const ADD_REDUCE_DECISION_ID = '44444444-4444-4444-4444-444444444444'

Deno.test('addToPosition: multiple ADDs produce a true weighted-average entry', () => {
  const opened = openPosition({
    asset: 'BTC', direction: 'long', referencePrice: 100, notionalUsd: 1000,
    stopLossPrice: 50, takeProfitPrice: 200, feeBps: 0, slippageBps: 0,
    portfolioId: PORTFOLIO_ID, decisionId: OPEN_DECISION_ID, startingCash: 10_000, nowIso: T0,
  })
  assertAlmostEquals(opened.position.quantity, 10, 1e-9)
  assertAlmostEquals(opened.position.entryPrice, 100, 1e-9)

  const add1 = addToPosition({
    position: opened.position, referencePrice: 120, addNotionalUsd: 600,
    feeBps: 0, slippageBps: 0, decisionId: ADD_REDUCE_DECISION_ID, startingCash: opened.cashAfter, nowIso: T1,
  })
  // qty: 10 + 600/120 = 10 + 5 = 15. costBasis: 1000 + 600 = 1600. entry: 1600/15.
  assertAlmostEquals(add1.updatedPosition.quantity, 15, 1e-9)
  assertAlmostEquals(add1.updatedPosition.costBasis, 1600, 1e-9)
  assertAlmostEquals(add1.updatedPosition.entryPrice, 1600 / 15, 1e-9)
  assertEquals(add1.trade.intent, 'ADD_LONG')
  assertEquals(add1.trade.realizedPnl, null, 'nothing realized on an ADD')
  // SL/TP untouched — this function has no authority to move them.
  assertAlmostEquals(add1.updatedPosition.stopLossPrice, 50, 1e-9)
  assertAlmostEquals(add1.updatedPosition.takeProfitPrice, 200, 1e-9)

  const add2 = addToPosition({
    position: add1.updatedPosition, referencePrice: 140, addNotionalUsd: 700,
    feeBps: 0, slippageBps: 0, decisionId: ADD_REDUCE_DECISION_ID, startingCash: add1.cashAfter, nowIso: T1,
  })
  // qty: 15 + 700/140 = 15 + 5 = 20. costBasis: 1600 + 700 = 2300. entry: 2300/20 = 115 exactly.
  assertAlmostEquals(add2.updatedPosition.quantity, 20, 1e-9)
  assertAlmostEquals(add2.updatedPosition.costBasis, 2300, 1e-9)
  assertAlmostEquals(add2.updatedPosition.entryPrice, 115, 1e-9)
})

Deno.test('addToPosition + reducePosition: a profitable round trip realizes P&L only on the reduced portion, remainder stays open at the same entry', () => {
  const opened = openPosition({
    asset: 'BTC', direction: 'long', referencePrice: 100, notionalUsd: 1000,
    stopLossPrice: 50, takeProfitPrice: 200, feeBps: 10, slippageBps: 0,
    portfolioId: PORTFOLIO_ID, decisionId: OPEN_DECISION_ID, startingCash: 10_000, nowIso: T0,
  })
  const added = addToPosition({
    position: opened.position, referencePrice: 110, addNotionalUsd: 550,
    feeBps: 10, slippageBps: 0, decisionId: ADD_REDUCE_DECISION_ID, startingCash: opened.cashAfter, nowIso: T1,
  })
  // qty 15, costBasis 1550, entry 1550/15 = 103.333...
  assertAlmostEquals(added.updatedPosition.quantity, 15, 1e-9)
  assertAlmostEquals(added.updatedPosition.entryPrice, 1550 / 15, 1e-9)

  const reduced = reducePosition({
    position: added.updatedPosition, attemptedFillPrice: 130, reduceQuantity: 5,
    feeBps: 10, slippageBps: 0, decisionId: ADD_REDUCE_DECISION_ID, startingCash: added.cashAfter, nowIso: T1,
  })
  // realizedPnl = (130 - 1550/15) * 5 = (130 - 103.3333...) * 5 = 133.3333...
  assertAlmostEquals(reduced.realizedPnl, (130 - 1550 / 15) * 5, 1e-9)
  assertEquals(reduced.realizedPnl > 0, true, 'profitable')
  assertAlmostEquals(reduced.updatedPosition.quantity, 10, 1e-9)
  // costBasisReleased = 1550 * (5/15) = 516.666...; remaining costBasis = 1033.333...
  assertAlmostEquals(reduced.updatedPosition.costBasis, 1550 - (1550 * 5) / 15, 1e-9)
  // entryPrice UNCHANGED by the reduce — and still exactly costBasis/quantity, proving the invariant survives a partial exit.
  assertAlmostEquals(reduced.updatedPosition.entryPrice, added.updatedPosition.entryPrice, 1e-9)
  assertAlmostEquals(reduced.updatedPosition.entryPrice, reduced.updatedPosition.costBasis / reduced.updatedPosition.quantity, 1e-9)
  assertEquals(reduced.trade.intent, 'REDUCE_LONG')
  assertAlmostEquals(reduced.trade.realizedPnl!, reduced.realizedPnl, 1e-9, 'the trade row and the return value must agree')
})

Deno.test('addToPosition + reducePosition: a losing round trip realizes a negative P&L on the reduced portion', () => {
  const opened = openPosition({
    asset: 'BTC', direction: 'long', referencePrice: 100, notionalUsd: 1000,
    stopLossPrice: 50, takeProfitPrice: 200, feeBps: 0, slippageBps: 0,
    portfolioId: PORTFOLIO_ID, decisionId: OPEN_DECISION_ID, startingCash: 10_000, nowIso: T0,
  })
  const added = addToPosition({
    position: opened.position, referencePrice: 90, addNotionalUsd: 450,
    feeBps: 0, slippageBps: 0, decisionId: ADD_REDUCE_DECISION_ID, startingCash: opened.cashAfter, nowIso: T1,
  })
  // qty 15, costBasis 1450, entry 1450/15 = 96.666...
  assertAlmostEquals(added.updatedPosition.entryPrice, 1450 / 15, 1e-9)

  const reduced = reducePosition({
    position: added.updatedPosition, attemptedFillPrice: 80, reduceQuantity: 6,
    feeBps: 0, slippageBps: 0, decisionId: ADD_REDUCE_DECISION_ID, startingCash: added.cashAfter, nowIso: T1,
  })
  // realizedPnl = (80 - 96.666...) * 6 = -100 exactly.
  assertAlmostEquals(reduced.realizedPnl, -100, 1e-9)
  assertAlmostEquals(reduced.updatedPosition.quantity, 9, 1e-9)
})

Deno.test('reducePosition: fees can turn a nominally profitable reduce net-negative once round-trip costs are counted', () => {
  // Deliberately large fee (100 bps) and a tiny 0.5% price move — the
  // price-only realizedPnl is positive, but the two fees (open + reduce)
  // together exceed it, so the trade is a net loser despite looking
  // "profitable" if you only read realizedPnl in isolation.
  const opened = openPosition({
    asset: 'BTC', direction: 'long', referencePrice: 100, notionalUsd: 10_000,
    stopLossPrice: 50, takeProfitPrice: 200, feeBps: 100, slippageBps: 0,
    portfolioId: PORTFOLIO_ID, decisionId: OPEN_DECISION_ID, startingCash: 20_000, nowIso: T0,
  })
  assertAlmostEquals(opened.trade.fee, 100, 1e-9) // 1% of 10,000

  const reduced = reducePosition({
    position: opened.position, attemptedFillPrice: 100.5, reduceQuantity: opened.position.quantity,
    feeBps: 100, slippageBps: 0, decisionId: ADD_REDUCE_DECISION_ID, startingCash: opened.cashAfter, nowIso: T1,
  })
  // realizedPnl = (100.5 - 100) * 100 = 50 — nominally profitable.
  assertAlmostEquals(reduced.realizedPnl, 50, 1e-9)
  assertEquals(reduced.realizedPnl > 0, true, 'nominally profitable on price alone')

  const totalFees = opened.trade.fee + reduced.trade.fee
  assertAlmostEquals(totalFees, 100 + 100.5, 1e-9)
  assertEquals(reduced.realizedPnl - totalFees < 0, true, 'net-negative once round-trip fees are counted, despite a positive realizedPnl')
})

// --- Aggressive V3.1 profit recycling: partialRealizedPnlDelta must be
// NET of fee, unlike realizedPnl/trade.realizedPnl which stay gross
// (migration plan's "positionPnlR must be economically net" correction) --

Deno.test('reducePosition: partialRealizedPnlDelta is realizedPnl NET of the fee this reduce actually paid — realizedPnl itself stays gross', () => {
  const opened = openPosition({
    asset: 'BTC', direction: 'long', referencePrice: 100, notionalUsd: 10_000,
    stopLossPrice: 50, takeProfitPrice: 200, feeBps: 100, slippageBps: 0,
    portfolioId: PORTFOLIO_ID, decisionId: OPEN_DECISION_ID, startingCash: 20_000, nowIso: T0,
  })
  const reduced = reducePosition({
    position: opened.position, attemptedFillPrice: 100.5, reduceQuantity: opened.position.quantity,
    feeBps: 100, slippageBps: 0, decisionId: ADD_REDUCE_DECISION_ID, startingCash: opened.cashAfter, nowIso: T1,
  })
  // realizedPnl = (100.5-100)*100 = 50 (gross, price-only); this reduce's
  // own fee = grossValue(100.5*100=10050) * 1% = 100.5.
  assertAlmostEquals(reduced.realizedPnl, 50, 1e-9)
  assertAlmostEquals(reduced.trade.fee, 100.5, 1e-9)
  assertAlmostEquals(reduced.partialRealizedPnlDelta, 50 - 100.5, 1e-9)
  assertEquals(reduced.partialRealizedPnlDelta < reduced.realizedPnl, true, 'the net figure must be strictly less than the gross one whenever a real fee applies')
})

Deno.test('reducePosition: updatedPosition.partialRealizedPnlUsd accumulates the NET figure, not the gross realizedPnl', () => {
  const opened = openPosition({
    asset: 'BTC', direction: 'long', referencePrice: 100, notionalUsd: 10_000,
    stopLossPrice: 50, takeProfitPrice: 200, feeBps: 100, slippageBps: 0,
    portfolioId: PORTFOLIO_ID, decisionId: OPEN_DECISION_ID, startingCash: 20_000, nowIso: T0,
  })
  const reduced = reducePosition({
    position: opened.position, attemptedFillPrice: 100.5, reduceQuantity: opened.position.quantity / 2,
    feeBps: 100, slippageBps: 0, decisionId: ADD_REDUCE_DECISION_ID, startingCash: opened.cashAfter, nowIso: T1,
  })
  assertAlmostEquals(reduced.updatedPosition.partialRealizedPnlUsd!, reduced.partialRealizedPnlDelta, 1e-9)
  assertEquals(reduced.updatedPosition.partialRealizedPnlUsd! < reduced.realizedPnl, true)
})

Deno.test('reducePosition: partialRealizedPnlDelta accumulates correctly (net) across two successive REDUCEs on the same position', () => {
  const opened = openPosition({
    asset: 'BTC', direction: 'long', referencePrice: 100, notionalUsd: 10_000,
    stopLossPrice: 50, takeProfitPrice: 200, feeBps: 100, slippageBps: 0,
    portfolioId: PORTFOLIO_ID, decisionId: OPEN_DECISION_ID, startingCash: 20_000, nowIso: T0,
  })
  const firstReduce = reducePosition({
    position: opened.position, attemptedFillPrice: 105, reduceQuantity: 30,
    feeBps: 100, slippageBps: 0, decisionId: ADD_REDUCE_DECISION_ID, startingCash: opened.cashAfter, nowIso: T1,
  })
  const secondReduce = reducePosition({
    position: firstReduce.updatedPosition, attemptedFillPrice: 108, reduceQuantity: 30,
    feeBps: 100, slippageBps: 0, decisionId: ADD_REDUCE_DECISION_ID, startingCash: firstReduce.cashAfter, nowIso: T1,
  })
  const expectedTotal = firstReduce.partialRealizedPnlDelta + secondReduce.partialRealizedPnlDelta
  assertAlmostEquals(secondReduce.updatedPosition.partialRealizedPnlUsd!, expectedTotal, 1e-9)
  const grossTotal = firstReduce.realizedPnl + secondReduce.realizedPnl
  assertEquals(expectedTotal < grossTotal, true, 'the compounded NET figure must trail the compounded GROSS figure by the cumulative fees paid — the exact failure mode this fix closes')
})

Deno.test('reducePosition: a 100% reduce is arithmetically IDENTICAL to closePosition — the same trade/cash numbers, proving REDUCE-to-zero is safe to treat as a close', () => {
  const opened = openPosition({
    asset: 'BTC', direction: 'long', referencePrice: 100, notionalUsd: 1000,
    stopLossPrice: 50, takeProfitPrice: 200, feeBps: 10, slippageBps: 5,
    portfolioId: PORTFOLIO_ID, decisionId: OPEN_DECISION_ID, startingCash: 10_000, nowIso: T0,
  })

  const reduced = reducePosition({
    position: opened.position, attemptedFillPrice: 120, reduceQuantity: opened.position.quantity,
    feeBps: 10, slippageBps: 5, decisionId: ADD_REDUCE_DECISION_ID, startingCash: opened.cashAfter, nowIso: T1,
  })
  const closed = closePosition({
    position: opened.position, attemptedFillPrice: 120,
    feeBps: 10, slippageBps: 5, closeReason: 'agent_close', decisionId: ADD_REDUCE_DECISION_ID, startingCash: opened.cashAfter, nowIso: T1,
  })

  assertAlmostEquals(reduced.trade.fillPrice, closed.trade.fillPrice, 1e-9)
  assertAlmostEquals(reduced.trade.grossValue, closed.trade.grossValue, 1e-9)
  assertAlmostEquals(reduced.trade.fee, closed.trade.fee, 1e-9)
  assertAlmostEquals(reduced.trade.slippageCost, closed.trade.slippageCost, 1e-9)
  assertAlmostEquals(reduced.trade.netCashDelta, closed.trade.netCashDelta, 1e-9)
  assertAlmostEquals(reduced.cashAfter, closed.cashAfter, 1e-9)
  assertAlmostEquals(reduced.realizedPnl, closed.realizedPnl, 1e-9)
  assertAlmostEquals(reduced.updatedPosition.quantity, 0, 1e-9)
  assertAlmostEquals(reduced.updatedPosition.costBasis, 0, 1e-9)
  // What does NOT match, by design: reducePosition never sets status/
  // closedAt/closeReason — that is exactly why a >=100% REDUCE magnitude
  // must be normalized to an actual CLOSE upstream (cycle/apply-
  // management.ts), never executed as a REDUCE at the broker layer. A
  // quantity-0 OPEN position would violate positions_qty_positive at the
  // DB level; this test proves the ARITHMETIC is safe, not that skipping
  // the normalization is.
  assertEquals(reduced.updatedPosition.status, 'open')
  assertEquals(closed.closedPosition.status, 'closed')
})

Deno.test('reducePosition: a short reduce applies the same exhaustion clamp as closePosition', () => {
  const opened = openPosition({
    asset: 'BTC', direction: 'short', referencePrice: 100, notionalUsd: 1000,
    stopLossPrice: 190, takeProfitPrice: 50, feeBps: 0, slippageBps: 0,
    portfolioId: PORTFOLIO_ID, decisionId: OPEN_DECISION_ID, startingCash: 10_000, nowIso: T0,
  })
  // Price gaps past 2x entry (200) — exhaustion clamp must fire, same as closePosition's.
  const reduced = reducePosition({
    position: opened.position, attemptedFillPrice: 250, reduceQuantity: opened.position.quantity,
    feeBps: 0, slippageBps: 0, decisionId: ADD_REDUCE_DECISION_ID, startingCash: opened.cashAfter, nowIso: T1,
  })
  assertAlmostEquals(reduced.trade.fillPrice, 200, 1e-9, 'clamped to exactly 2x entry, not the observed 250')
})

Deno.test('addToPosition + reducePosition: type check — a Position produced by either function still satisfies the Position shape (spot-check via field access)', () => {
  const opened = openPosition({
    asset: 'ETH', direction: 'long', referencePrice: 50, notionalUsd: 500,
    stopLossPrice: 25, takeProfitPrice: 100, feeBps: 0, slippageBps: 0,
    portfolioId: PORTFOLIO_ID, decisionId: OPEN_DECISION_ID, startingCash: 10_000, nowIso: T0,
  })
  const added = addToPosition({
    position: opened.position, referencePrice: 55, addNotionalUsd: 110,
    feeBps: 0, slippageBps: 0, decisionId: ADD_REDUCE_DECISION_ID, startingCash: opened.cashAfter, nowIso: T1,
  })
  const position: Position = added.updatedPosition
  assertEquals(position.status, 'open')
  assertEquals(position.asset, 'ETH')
})
