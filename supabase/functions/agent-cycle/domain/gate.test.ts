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
  assertAlmostEquals(result.approvedSizePct!, 0.05, 1e-9)
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
