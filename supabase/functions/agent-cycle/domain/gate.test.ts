import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import { evaluateRiskGate, type RiskGateContext } from '../../../../src/shared/risk/gate.ts'
import type { ModelDecisionProposal } from '../../../../src/shared/decisions/types.ts'

// maxTakeProfitPct 0.90 — raised from 0.50 by the Trading Strategy V1
// migration (sl-tp.test.ts's SEEDED_BOUNDS has the full rationale).
const SEEDED_BOUNDS = { minStopLossPct: 0.005, maxStopLossPct: 0.15, minTakeProfitPct: 0.005, maxTakeProfitPct: 0.90 }

function baseContext(overrides: Partial<RiskGateContext> = {}): RiskGateContext {
  return {
    currentState: 'FLAT',
    entryPrice: 76851,
    nav: 10000,
    cash: 10000,
    effectiveMinConfidence: 0.65,
    effectiveRiskBudgetPct: 0.01,
    effectiveSingleTradeCapPct: 0.20,
    effectiveAssetExposureCapPct: 0.35,
    slTpBounds: SEEDED_BOUNDS,
    currentAssetExposureUsd: 0,
    stopOutReentryBlockMinutes: 360,
    recentStopLossClose: null,
    nowIso: '2026-09-18T12:00:00.000Z',
    // Generous, non-binding defaults for the trading-strategy-v1.md §17
    // portfolio-risk fields — large enough that no pre-existing test in
    // this file accidentally trips a new cap/breaker; the dedicated
    // "Portfolio risk" and "Drawdown breaker" test blocks below override
    // these explicitly to exercise each one.
    portfolioRiskCeilingUsd: 10_000,
    otherOpenPositionsRiskAtStopUsd: 0,
    maxTotalNotionalUsd: 10_000,
    otherSameDirectionNotionalUsd: 0,
    peakNav: 10_000, // == the default nav above -> zero drawdown by default
    drawdownBreakerFloorPct: 0.90,
    // Phase 2 (2026-09-22) defaults — non-binding unless a test overrides
    // them. openPosition: null matches currentState: 'FLAT' above; any
    // test exercising ADD/REDUCE/MODIFY_PROTECTION must override both
    // together.
    openPosition: null,
    feeBps: 10,
    slippageBps: 5,
    minTradeNotionalPct: 0.01,
    minTradeNotionalUsd: 25,
    ...overrides,
  }
}

function openLongProposal(overrides: Partial<Record<string, unknown>> = {}): ModelDecisionProposal {
  return {
    asset: 'BTC',
    action: 'OPEN_LONG',
    confidence: 0.74,
    stopLossPct: 0.03,
    takeProfitPct: 0.10,
    horizonHours: 48,
    reasons: [{ type: 'TECHNICAL', text: 'Price above EMA20/EMA50.' }],
    invalidation: [{ text: 'Price breaks below EMA50.' }],
    ...overrides,
  } as ModelDecisionProposal
}

// --- HOLD ------------------------------------------------------------
//
// State-dependent invalidation requirement, added as a narrow corrective
// fix after Step 6 (progress-tracker.md Open Questions): a HOLD while
// FLAT has no open thesis to invalidate, so empty invalidation is valid.
// A HOLD on an open LONG/SHORT is implicitly reaffirming an existing
// thesis and must carry non-empty invalidation, or it's rejected rather
// than silently treated as a valid not_applicable HOLD. This supersedes
// the old blanket "HOLD is always not_applicable, regardless of state"
// test, which asserted exactly the gap this fix closes.

function hold(invalidation: ModelDecisionProposal['invalidation'] = []): ModelDecisionProposal {
  return { asset: 'BTC', action: 'HOLD', confidence: 0.5, horizonHours: null, reasons: [], invalidation }
}

Deno.test('evaluateRiskGate: FLAT + HOLD + empty invalidation -> valid (not_applicable)', () => {
  const result = evaluateRiskGate(hold(), baseContext({ currentState: 'FLAT' }))
  assertEquals(result.riskStatus, 'not_applicable')
  assertEquals(result.riskReason, null)
})

Deno.test('evaluateRiskGate: LONG + HOLD + empty invalidation -> rejected', () => {
  const result = evaluateRiskGate(hold(), baseContext({ currentState: 'LONG' }))
  assertEquals(result.riskStatus, 'rejected')
  assertEquals(result.riskReason?.includes('invalidation'), true)
})

Deno.test('evaluateRiskGate: SHORT + HOLD + empty invalidation -> rejected', () => {
  const result = evaluateRiskGate(hold(), baseContext({ currentState: 'SHORT' }))
  assertEquals(result.riskStatus, 'rejected')
  assertEquals(result.riskReason?.includes('invalidation'), true)
})

Deno.test('evaluateRiskGate: LONG/SHORT + HOLD + non-empty invalidation -> valid (not_applicable)', () => {
  for (const state of ['LONG', 'SHORT'] as const) {
    const result = evaluateRiskGate(hold([{ text: 'Price closes back below the 50-day EMA.' }]), baseContext({ currentState: state }))
    assertEquals(result.riskStatus, 'not_applicable')
    assertEquals(result.riskReason, null)
  }
})

// --- CLOSE — never gated by confidence, re-entry block, or caps --------

Deno.test('evaluateRiskGate: CLOSE from FLAT is rejected — nothing to close', () => {
  const close: ModelDecisionProposal = { asset: 'BTC', action: 'CLOSE', confidence: 0.9, horizonHours: null, reasons: [], invalidation: [] }
  const result = evaluateRiskGate(close, baseContext({ currentState: 'FLAT' }))
  assertEquals(result.riskStatus, 'rejected')
})

Deno.test('evaluateRiskGate: CLOSE from LONG is approved even with very low confidence — confidence never gates an exit', () => {
  const close: ModelDecisionProposal = { asset: 'BTC', action: 'CLOSE', confidence: 0.01, horizonHours: null, reasons: [], invalidation: [] }
  const result = evaluateRiskGate(close, baseContext({ currentState: 'LONG', effectiveMinConfidence: 0.99 }))
  assertEquals(result.riskStatus, 'approved')
  assertEquals(result.approvedSizePct, null) // a close never sizes — it exits in full
})

Deno.test('evaluateRiskGate: CLOSE from SHORT is approved even with an active stop-out re-entry block — CLOSE is never blocked by anything', () => {
  const close: ModelDecisionProposal = { asset: 'BTC', action: 'CLOSE', confidence: 0.9, horizonHours: null, reasons: [], invalidation: [] }
  const result = evaluateRiskGate(close, baseContext({
    currentState: 'SHORT',
    recentStopLossClose: { direction: 'short', closedAt: '2026-09-18T11:59:00.000Z' }, // 1 minute ago
  }))
  assertEquals(result.riskStatus, 'approved')
})

// --- OPEN_LONG / OPEN_SHORT: state validity ------------------------------

Deno.test('evaluateRiskGate: OPEN_LONG while already LONG is rejected', () => {
  const result = evaluateRiskGate(openLongProposal(), baseContext({ currentState: 'LONG' }))
  assertEquals(result.riskStatus, 'rejected')
})

Deno.test('evaluateRiskGate: OPEN_LONG while SHORT is also rejected (any non-FLAT state blocks any open)', () => {
  const result = evaluateRiskGate(openLongProposal(), baseContext({ currentState: 'SHORT' }))
  assertEquals(result.riskStatus, 'rejected')
})

// --- Confidence gating ---------------------------------------------------

Deno.test('evaluateRiskGate: OPEN_LONG below effective minimum confidence is rejected', () => {
  const result = evaluateRiskGate(openLongProposal({ confidence: 0.5 }), baseContext({ effectiveMinConfidence: 0.65 }))
  assertEquals(result.riskStatus, 'rejected')
  assertEquals(result.riskReason?.includes('confidence'), true)
})

// --- SL/TP validation ----------------------------------------------------

Deno.test('evaluateRiskGate: OPEN_LONG with a stop-loss outside configured bounds is rejected', () => {
  const result = evaluateRiskGate(openLongProposal({ stopLossPct: 0.001 }), baseContext())
  assertEquals(result.riskStatus, 'rejected')
})

// --- Stop-out re-entry block ----------------------------------------------

Deno.test('evaluateRiskGate: OPEN_LONG blocked by an active same-direction stop-out re-entry window', () => {
  const result = evaluateRiskGate(openLongProposal(), baseContext({
    recentStopLossClose: { direction: 'long', closedAt: '2026-09-18T06:00:00.000Z' }, // 360min block, now is +360min exactly minus a hair — use +200min to be unambiguous
    nowIso: '2026-09-18T09:20:00.000Z', // verified: 200 minutes after closedAt, inside the 360-minute window
  }))
  assertEquals(result.riskStatus, 'rejected')
  assertEquals(result.riskReason?.includes('re-entry'), true)
})

Deno.test('evaluateRiskGate: OPEN_LONG NOT blocked once the re-entry window has elapsed', () => {
  const result = evaluateRiskGate(openLongProposal(), baseContext({
    recentStopLossClose: { direction: 'long', closedAt: '2026-09-18T06:00:00.000Z' },
    nowIso: '2026-09-18T12:40:00.000Z', // verified: 400 minutes after closedAt, outside the 360-minute window
  }))
  assertEquals(result.riskStatus === 'rejected', false)
})

Deno.test('evaluateRiskGate: OPEN_SHORT is NOT blocked by a same-asset stop-out in the OPPOSITE direction', () => {
  const result = evaluateRiskGate(openLongProposal({ action: 'OPEN_SHORT' }), baseContext({
    recentStopLossClose: { direction: 'long', closedAt: '2026-09-18T06:00:00.000Z' }, // the stop-out was on LONG
    nowIso: '2026-09-18T06:05:00.000Z', // well inside what WOULD be the block window, if direction matched
  }))
  assertEquals(result.riskStatus === 'rejected', false)
})

// --- Sizing, reusing the independently-verified numbers from sizing.test.ts ---

Deno.test('evaluateRiskGate: the worked example end-to-end — clamped by the single-trade cap at 3% stop', () => {
  const result = evaluateRiskGate(openLongProposal({ stopLossPct: 0.03 }), baseContext())
  assertEquals(result.riskStatus, 'clamped')
  assertEquals(result.sizeCapApplied, 'single_trade')
  assertAlmostEquals(result.approvedSizePct!, 0.20, 1e-6)
  assertAlmostEquals(result.computedStopLossPrice!, 74545.47, 0.01)
  assertAlmostEquals(result.computedTakeProfitPrice!, 84536.10, 0.01)
})

Deno.test('evaluateRiskGate: a wider stop (8%) is approved outright — the risk budget governs, no cap', () => {
  const result = evaluateRiskGate(openLongProposal({ stopLossPct: 0.08 }), baseContext())
  assertEquals(result.riskStatus, 'approved')
  assertEquals(result.sizeCapApplied, null)
  assertAlmostEquals(result.approvedSizePct!, 0.125, 1e-3)
})

Deno.test('evaluateRiskGate: cash-constrained open is clamped by the cash cap, not rejected', () => {
  const result = evaluateRiskGate(openLongProposal({ stopLossPct: 0.03 }), baseContext({ cash: 500 }))
  assertEquals(result.riskStatus, 'clamped')
  assertEquals(result.sizeCapApplied, 'cash')
  // Phase 2 (2026-09-22): the cash cap now reserves fee+slippage headroom
  // (feeBps: 10, slippageBps: 5 from baseContext) rather than passing raw
  // cash straight through — 500 / ((1+0.0005)*(1+0.001)) ≈ 499.2508, so
  // the approved fraction of the $10,000 NAV is slightly under the naive
  // 0.05, not exactly it. Independently verified: 500 / 1.0015005 =
  // 499.250874..., / 10000 = 0.0499250874...
  assertAlmostEquals(result.approvedSizePct!, 0.0499250874, 1e-9)
})

Deno.test('evaluateRiskGate: zero available cash results in outright rejection, not a clamp to zero', () => {
  const result = evaluateRiskGate(openLongProposal({ stopLossPct: 0.03 }), baseContext({ cash: 0 }))
  assertEquals(result.riskStatus, 'rejected')
  assertEquals(result.approvedSizePct, null)
})

// --- Short direction, end-to-end -----------------------------------------

// --- Portfolio risk (trading-strategy-v1.md §17) --------------------------

Deno.test('evaluateRiskGate: the portfolio risk ceiling clamps tighter than the single-trade cap', () => {
  // stopLossPct=0.03, risk-based notional = 10000*0.01/0.03 = 3333.33,
  // single_trade cap = 2000 — both bigger than the portfolio ceiling
  // below, so portfolio_risk must be the one that actually binds.
  // Remaining ceiling = 50 - 20 = 30; 30 / 0.03 = exactly 1000.
  const result = evaluateRiskGate(
    openLongProposal({ stopLossPct: 0.03 }),
    baseContext({ portfolioRiskCeilingUsd: 50, otherOpenPositionsRiskAtStopUsd: 20 }),
  )
  assertEquals(result.riskStatus, 'clamped')
  assertEquals(result.sizeCapApplied, 'portfolio_risk')
  assertAlmostEquals(result.approvedSizePct!, 0.10, 1e-9) // 1000 / 10000
})

Deno.test('evaluateRiskGate: a fully-consumed portfolio risk ceiling rejects outright, not a clamp to zero', () => {
  const result = evaluateRiskGate(
    openLongProposal({ stopLossPct: 0.03 }),
    baseContext({ portfolioRiskCeilingUsd: 50, otherOpenPositionsRiskAtStopUsd: 50 }),
  )
  assertEquals(result.riskStatus, 'rejected')
  assertEquals(result.riskReason?.includes('portfolio_risk'), true)
})

Deno.test('evaluateRiskGate: the total notional cap clamps independently of the risk-at-stop ceiling', () => {
  // Remaining notional = 3000 - 1500 = 1500, below both the 2000
  // single-trade cap and the 3333.33 risk-based figure.
  const result = evaluateRiskGate(
    openLongProposal({ stopLossPct: 0.03 }),
    baseContext({ maxTotalNotionalUsd: 3000, otherSameDirectionNotionalUsd: 1500 }),
  )
  assertEquals(result.riskStatus, 'clamped')
  assertEquals(result.sizeCapApplied, 'total_notional')
  assertAlmostEquals(result.approvedSizePct!, 0.15, 1e-9) // 1500 / 10000
})

// --- Drawdown breaker (§17.3) ----------------------------------------------

Deno.test('evaluateRiskGate: OPEN_LONG is rejected while NAV sits below the drawdown floor', () => {
  // peakNav 10000, floor 0.90 -> floor NAV 9000; current nav 8000 is
  // below it.
  const result = evaluateRiskGate(
    openLongProposal(),
    baseContext({ nav: 8000, peakNav: 10_000, drawdownBreakerFloorPct: 0.90 }),
  )
  assertEquals(result.riskStatus, 'rejected')
  assertEquals(result.riskReason?.includes('drawdown'), true)
})

Deno.test('evaluateRiskGate: exactly at the drawdown floor is NOT blocked (boundary inclusive)', () => {
  const result = evaluateRiskGate(
    openLongProposal(),
    baseContext({ nav: 9000, peakNav: 10_000, drawdownBreakerFloorPct: 0.90 }),
  )
  assertEquals(result.riskStatus === 'rejected', false)
})

Deno.test('evaluateRiskGate: CLOSE is approved even deep in a drawdown — the breaker never blocks exits', () => {
  const proposal: ModelDecisionProposal = { asset: 'BTC', action: 'CLOSE', confidence: 0.5, horizonHours: null, reasons: [], invalidation: [] }
  const result = evaluateRiskGate(
    proposal,
    baseContext({ currentState: 'LONG', nav: 5000, peakNav: 10_000, drawdownBreakerFloorPct: 0.90 }),
  )
  assertEquals(result.riskStatus, 'approved')
})

Deno.test('evaluateRiskGate: a peakNav of 0 (no NAV history yet) never triggers the breaker', () => {
  const result = evaluateRiskGate(openLongProposal(), baseContext({ nav: 10_000, peakNav: 0 }))
  assertEquals(result.riskStatus === 'rejected', false)
})

Deno.test('evaluateRiskGate: OPEN_SHORT computes correctly-ordered SL/TP prices (SL above entry, TP below)', () => {
  const proposal = openLongProposal({ asset: 'BTC', action: 'OPEN_SHORT', stopLossPct: 0.03, takeProfitPct: 0.10 })
  const result = evaluateRiskGate(proposal, baseContext({ entryPrice: 100 }))
  assertAlmostEquals(result.computedStopLossPrice!, 103, 1e-9)
  assertAlmostEquals(result.computedTakeProfitPrice!, 90, 1e-9)
})

// --- Phase 2 (2026-09-22) — ADD -------------------------------------------

function addProposal(overrides: Partial<Record<string, unknown>> = {}): ModelDecisionProposal {
  return {
    asset: 'BTC', action: 'ADD', confidence: 0.7, horizonHours: null,
    reasons: [{ type: 'TECHNICAL', text: 'Jev recommended adding to the position.' }],
    invalidation: [], addMagnitude: 0.5,
    ...overrides,
  } as ModelDecisionProposal
}

const LONG_POSITION = { quantity: 10, entryPrice: 100, stopLossPrice: 90, takeProfitPrice: 180 }
const SHORT_POSITION = { quantity: 10, entryPrice: 100, stopLossPrice: 110, takeProfitPrice: 50 }

Deno.test('evaluateRiskGate: ADD with no open position is rejected', () => {
  const result = evaluateRiskGate(addProposal(), baseContext({ currentState: 'FLAT', openPosition: null }))
  assertEquals(result.riskStatus, 'rejected')
})

Deno.test('evaluateRiskGate: a valid ADD is approved at the risk-derived notional (no cap binds)', () => {
  // riskBasedMaxAdd = deriveRiskBasedNotional(10000, 0.01, 100, 90) = 100/10*100 = 1000
  // proposedNotional = 1000 * 0.5 = 500
  const result = evaluateRiskGate(addProposal({ addMagnitude: 0.5 }), baseContext({ currentState: 'LONG', openPosition: LONG_POSITION, entryPrice: 100 }))
  assertEquals(result.riskStatus, 'approved')
  assertEquals(result.sizeCapApplied, null)
  assertAlmostEquals(result.approvedAdjustNotionalUsd!, 500, 1e-6)
  assertAlmostEquals(result.computedStopLossPrice!, 90, 1e-9)
  assertAlmostEquals(result.computedTakeProfitPrice!, 180, 1e-9)
})

Deno.test('evaluateRiskGate: an ADD clamped by the asset-exposure cap is clamped, not rejected', () => {
  // currentAssetExposureUsd = 10 * 100 = 1000. nav*0.11 - 1000 = 1100-1000 = 100, well below the 1000 risk-based figure.
  const result = evaluateRiskGate(
    addProposal({ addMagnitude: 1.0 }),
    baseContext({ currentState: 'LONG', openPosition: LONG_POSITION, entryPrice: 100, effectiveAssetExposureCapPct: 0.11 }),
  )
  assertEquals(result.riskStatus, 'clamped')
  assertEquals(result.sizeCapApplied, 'asset_exposure')
  assertAlmostEquals(result.approvedAdjustNotionalUsd!, 100, 1e-6)
})

Deno.test('evaluateRiskGate: an ADD clamped by the cash cap (with fee/slippage headroom reserved)', () => {
  const result = evaluateRiskGate(
    addProposal({ addMagnitude: 1.0 }),
    baseContext({ currentState: 'LONG', openPosition: LONG_POSITION, entryPrice: 100, cash: 150 }),
  )
  assertEquals(result.riskStatus, 'clamped')
  assertEquals(result.sizeCapApplied, 'cash')
  assertAlmostEquals(result.approvedAdjustNotionalUsd!, 150 / 1.0015005, 1e-6)
})

Deno.test('evaluateRiskGate: an ADD below the minimum trade notional is normalized (not_applicable), not rejected', () => {
  const result = evaluateRiskGate(
    addProposal({ addMagnitude: 0.001 }),
    baseContext({ currentState: 'LONG', openPosition: LONG_POSITION, entryPrice: 100 }),
  )
  assertEquals(result.riskStatus, 'not_applicable')
  assertEquals(result.riskReason?.includes('minimum trade notional'), true)
})

Deno.test('evaluateRiskGate: an ADD is rejected when it pushes the EXISTING stop distance outside configured bounds under the new weighted entry', () => {
  // Price pumped 100 -> 300; adding at the higher price drags the
  // weighted entry up while the absolute stop (90) stays fixed, pushing
  // the stop's PERCENTAGE distance from 10% to exactly 17.5% — above
  // maxStopLossPct (0.15). Independently verified: newEntry = 1200/11 ≈
  // 109.09, stopLossPct = 210/1200 = 0.175 exactly.
  const result = evaluateRiskGate(
    addProposal({ addMagnitude: 1.0 }),
    baseContext({ currentState: 'LONG', openPosition: LONG_POSITION, entryPrice: 300 }),
  )
  assertEquals(result.riskStatus, 'rejected')
  assertEquals(result.riskReason?.includes('existing protection becomes invalid'), true)
  // SL/TP were never touched — the rejection means nothing executes, not
  // that they were silently moved.
})

Deno.test('evaluateRiskGate: a SHORT ADD uses short-side formulas correctly, not silently mis-signed as long', () => {
  // riskBasedMaxAdd = deriveRiskBasedNotional(10000, 0.01, 90, 110) = 100/20*90 = 450; * 0.5 = 225
  const result = evaluateRiskGate(
    addProposal({ addMagnitude: 0.5 }),
    baseContext({ currentState: 'SHORT', openPosition: SHORT_POSITION, entryPrice: 90 }),
  )
  assertEquals(result.riskStatus, 'approved')
  assertAlmostEquals(result.approvedAdjustNotionalUsd!, 225, 1e-6)
})

// --- Phase 2 — REDUCE ------------------------------------------------------

function reduceProposal(overrides: Partial<Record<string, unknown>> = {}): ModelDecisionProposal {
  return {
    asset: 'BTC', action: 'REDUCE', confidence: 0.7, horizonHours: null,
    reasons: [{ type: 'TECHNICAL', text: 'Jev recommended trimming the position.' }],
    invalidation: [], reduceMagnitude: 0.5,
    ...overrides,
  } as ModelDecisionProposal
}

Deno.test('evaluateRiskGate: REDUCE with no open position is rejected', () => {
  const result = evaluateRiskGate(reduceProposal(), baseContext({ currentState: 'FLAT', openPosition: null }))
  assertEquals(result.riskStatus, 'rejected')
})

Deno.test('evaluateRiskGate: a valid partial REDUCE is approved with the correct quantity and notional', () => {
  const result = evaluateRiskGate(
    reduceProposal({ reduceMagnitude: 0.5 }),
    baseContext({ currentState: 'LONG', openPosition: LONG_POSITION, entryPrice: 100 }),
  )
  assertEquals(result.riskStatus, 'approved')
  assertAlmostEquals(result.approvedReduceQuantity!, 5, 1e-9)
  assertAlmostEquals(result.approvedAdjustNotionalUsd!, 500, 1e-9)
  assertEquals(result.sizeCapApplied, null, 'REDUCE is never capped upward — only a floor and a <= quantity ceiling apply')
})

Deno.test('evaluateRiskGate: a REDUCE below the minimum trade notional is normalized (not_applicable), not rejected', () => {
  const result = evaluateRiskGate(
    reduceProposal({ reduceMagnitude: 0.001 }),
    baseContext({ currentState: 'LONG', openPosition: LONG_POSITION, entryPrice: 100 }),
  )
  assertEquals(result.riskStatus, 'not_applicable')
  assertEquals(result.riskReason?.includes('minimum trade notional'), true)
})

Deno.test('evaluateRiskGate: a REDUCE magnitude of 1.0 (should be normalized to CLOSE upstream) is still defensively clamped to the full quantity, not over-reduced', () => {
  const result = evaluateRiskGate(
    reduceProposal({ reduceMagnitude: 1.0 }),
    baseContext({ currentState: 'LONG', openPosition: LONG_POSITION, entryPrice: 100 }),
  )
  assertEquals(result.riskStatus, 'approved')
  assertAlmostEquals(result.approvedReduceQuantity!, 10, 1e-9, 'never more than the current quantity, regardless of magnitude')
})

// --- Phase 2 — MODIFY_PROTECTION -------------------------------------------

function modifyProtectionProposal(overrides: Partial<Record<string, unknown>> = {}): ModelDecisionProposal {
  return {
    asset: 'BTC', action: 'MODIFY_PROTECTION', confidence: 0.7, horizonHours: null,
    reasons: [{ type: 'TECHNICAL', text: 'Jev recommended tightening protection.' }],
    invalidation: [], proposedStopLossPrice: null, proposedTakeProfitPrice: null,
    ...overrides,
  } as ModelDecisionProposal
}

// Price has moved from entry (100) to 120, giving room to tighten a long's
// stop without instantly triggering it.
const LONG_POSITION_MOVED = { quantity: 10, entryPrice: 100, stopLossPrice: 90, takeProfitPrice: 180 }

Deno.test('evaluateRiskGate: MODIFY_PROTECTION with no open position is rejected', () => {
  const result = evaluateRiskGate(modifyProtectionProposal({ proposedStopLossPrice: 95 }), baseContext({ currentState: 'FLAT', openPosition: null }))
  assertEquals(result.riskStatus, 'rejected')
})

Deno.test('evaluateRiskGate: a long stop TIGHTEN is accepted', () => {
  const result = evaluateRiskGate(
    modifyProtectionProposal({ proposedStopLossPrice: 95 }),
    baseContext({ currentState: 'LONG', openPosition: LONG_POSITION_MOVED, entryPrice: 120 }),
  )
  assertEquals(result.riskStatus, 'approved')
  assertAlmostEquals(result.computedStopLossPrice!, 95, 1e-9)
  assertAlmostEquals(result.computedTakeProfitPrice!, 180, 1e-9, 'TP was not requested to change — KEPT at its existing value')
})

Deno.test('evaluateRiskGate: a long stop WIDEN is rejected — this is the one rule the whole action exists to enforce', () => {
  const result = evaluateRiskGate(
    modifyProtectionProposal({ proposedStopLossPrice: 85 }),
    baseContext({ currentState: 'LONG', openPosition: LONG_POSITION_MOVED, entryPrice: 120 }),
  )
  assertEquals(result.riskStatus, 'rejected')
  assertEquals(result.riskReason?.includes('widen'), true)
})

Deno.test('evaluateRiskGate: a stop request at/beyond the current market price is rejected as a disguised CLOSE, even though it technically tightens', () => {
  const result = evaluateRiskGate(
    modifyProtectionProposal({ proposedStopLossPrice: 125 }), // > 90 (tightens) but >= 120 (current price)
    baseContext({ currentState: 'LONG', openPosition: LONG_POSITION_MOVED, entryPrice: 120 }),
  )
  assertEquals(result.riskStatus, 'rejected')
  assertEquals(result.riskReason?.includes('execute immediately'), true)
})

Deno.test('evaluateRiskGate: a stop tighten violating the configured minimum distance is rejected', () => {
  const result = evaluateRiskGate(
    modifyProtectionProposal({ proposedStopLossPrice: 99.99 }), // 0.01% distance, below minStopLossPct (0.5%)
    baseContext({ currentState: 'LONG', openPosition: LONG_POSITION_MOVED, entryPrice: 120 }),
  )
  assertEquals(result.riskStatus, 'rejected')
  assertEquals(result.riskReason?.includes('outside configured bounds'), true)
})

Deno.test('evaluateRiskGate: a valid take-profit MOVE_CLOSER is accepted, SL kept unchanged', () => {
  const result = evaluateRiskGate(
    modifyProtectionProposal({ proposedTakeProfitPrice: 170 }),
    baseContext({ currentState: 'LONG', openPosition: LONG_POSITION_MOVED, entryPrice: 120 }),
  )
  assertEquals(result.riskStatus, 'approved')
  assertAlmostEquals(result.computedTakeProfitPrice!, 170, 1e-9)
  assertAlmostEquals(result.computedStopLossPrice!, 90, 1e-9)
})

Deno.test('evaluateRiskGate: a take-profit that would execute at or inside the current market price is rejected — MODIFY_PROTECTION must stay distinct from CLOSE', () => {
  const result = evaluateRiskGate(
    modifyProtectionProposal({ proposedTakeProfitPrice: 115 }), // <= 120 current price
    baseContext({ currentState: 'LONG', openPosition: LONG_POSITION_MOVED, entryPrice: 120 }),
  )
  assertEquals(result.riskStatus, 'rejected')
  assertEquals(result.riskReason?.includes('execute immediately'), true)
})

Deno.test('evaluateRiskGate: a SHORT stop tighten (moving DOWN) is accepted, using short-side rules correctly', () => {
  const result = evaluateRiskGate(
    modifyProtectionProposal({ proposedStopLossPrice: 105 }), // 110 -> 105 tightens for a short
    baseContext({ currentState: 'SHORT', openPosition: SHORT_POSITION, entryPrice: 90 }),
  )
  assertEquals(result.riskStatus, 'approved')
  assertAlmostEquals(result.computedStopLossPrice!, 105, 1e-9)
})

Deno.test('evaluateRiskGate: a SHORT stop WIDEN (moving UP) is rejected', () => {
  const result = evaluateRiskGate(
    modifyProtectionProposal({ proposedStopLossPrice: 115 }), // 110 -> 115 widens for a short
    baseContext({ currentState: 'SHORT', openPosition: SHORT_POSITION, entryPrice: 90 }),
  )
  assertEquals(result.riskStatus, 'rejected')
  assertEquals(result.riskReason?.includes('widen'), true)
})

// --- Phase 2 — exhaustiveness regression -----------------------------------
//
// The specific bug this migration closed: gate.ts used to derive direction
// via `proposal.action === 'OPEN_LONG' ? 'long' : 'short'` immediately
// after the HOLD/CLOSE branches — any new action reaching that line would
// have been silently treated as a short open. These tests exercise every
// new action against both LONG and SHORT open positions and assert the
// CORRECT side's formulas were used (short-side numbers, not long-side
// numbers reached via the old trap) — already covered individually above
// (the SHORT ADD and SHORT MODIFY_PROTECTION tests) but called out here
// explicitly as the regression this section exists to prevent.
Deno.test('evaluateRiskGate: REDUCE against a SHORT position computes symmetrically, not via any long-only path', () => {
  const result = evaluateRiskGate(
    reduceProposal({ reduceMagnitude: 0.5 }),
    baseContext({ currentState: 'SHORT', openPosition: SHORT_POSITION, entryPrice: 90 }),
  )
  assertEquals(result.riskStatus, 'approved')
  assertAlmostEquals(result.approvedReduceQuantity!, 5, 1e-9)
  assertAlmostEquals(result.approvedAdjustNotionalUsd!, 450, 1e-9) // 5 * 90 (current price)
})
