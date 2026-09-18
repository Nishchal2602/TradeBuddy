import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import { evaluateRiskGate, type RiskGateContext } from '../../../../src/shared/risk/gate.ts'
import type { ModelDecisionProposal } from '../../../../src/shared/decisions/types.ts'

const SEEDED_BOUNDS = { minStopLossPct: 0.005, maxStopLossPct: 0.15, minTakeProfitPct: 0.005, maxTakeProfitPct: 0.50 }

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

Deno.test('evaluateRiskGate: HOLD is always not_applicable, regardless of state', () => {
  const hold: ModelDecisionProposal = { asset: 'BTC', action: 'HOLD', confidence: 0.5, horizonHours: null, reasons: [], invalidation: [] }
  for (const state of ['FLAT', 'LONG', 'SHORT'] as const) {
    const result = evaluateRiskGate(hold, baseContext({ currentState: state }))
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

Deno.test('evaluateRiskGate: OPEN_SHORT computes correctly-ordered SL/TP prices (SL above entry, TP below)', () => {
  const proposal = openLongProposal({ asset: 'BTC', action: 'OPEN_SHORT', stopLossPct: 0.03, takeProfitPct: 0.10 })
  const result = evaluateRiskGate(proposal, baseContext({ entryPrice: 100 }))
  assertAlmostEquals(result.computedStopLossPrice!, 103, 1e-9)
  assertAlmostEquals(result.computedTakeProfitPrice!, 90, 1e-9)
})
