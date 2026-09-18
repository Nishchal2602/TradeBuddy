import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import { applySlippage, closePosition, computeNav, computePositionValue, openPosition } from './accounting.ts'
import { ACCOUNTING_SCENARIOS } from '../domain/contract.fixtures.ts'

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
