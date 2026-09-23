import { assertAlmostEquals, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { planDecisionExecution } from './plan-decision.ts'
import type { DecisionPlanInput } from './plan-decision.ts'
import type { Position } from '../../../../src/shared/positions/types.ts'
import type { ModelDecisionProposal } from '../../../../src/shared/decisions/types.ts'
import type { RiskGateResult } from '../../../../src/shared/risk/gate.ts'

const NOW = '2026-09-19T12:00:00.000Z'

function position(overrides: Partial<Position> = {}): Position {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    portfolioId: '22222222-2222-2222-2222-222222222222',
    asset: 'BTC',
    direction: 'long',
    quantity: 1,
    entryPrice: 100,
    costBasis: 100,
    stopLossPrice: 95,
    takeProfitPrice: 110,
    status: 'open',
    openedAt: '2026-09-19T06:00:00.000Z',
    closedAt: null,
    realizedPnl: null,
    closeReason: null,
    openedByDecisionId: '33333333-3333-3333-3333-333333333333',
    closedByDecisionId: null,
    ...overrides,
  }
}

// Phase 2 (2026-09-22): every RiskGateResult fixture in this file goes
// through this builder rather than a hand-typed literal, so the two new
// fields (approvedAdjustNotionalUsd, approvedReduceQuantity) default to
// null once, here, instead of at every call site.
function gateResult(overrides: Partial<RiskGateResult> = {}): RiskGateResult {
  return {
    riskStatus: 'not_applicable', riskReason: null, approvedSizePct: null,
    computedStopLossPrice: null, computedTakeProfitPrice: null, sizeCapApplied: null,
    approvedAdjustNotionalUsd: null, approvedReduceQuantity: null,
    ...overrides,
  }
}

function baseInput(overrides: Partial<DecisionPlanInput> = {}): DecisionPlanInput {
  return {
    asset: 'BTC',
    portfolioId: '22222222-2222-2222-2222-222222222222',
    proposal: { asset: 'BTC', action: 'HOLD', confidence: 0.5, horizonHours: null, reasons: [], invalidation: [] },
    gateResult: gateResult(),
    openPosition: null,
    nav: 10_000,
    referencePrice: 100,
    feeBps: 10,
    slippageBps: 5,
    startingCash: 10_000,
    decisionId: '44444444-4444-4444-4444-444444444444',
    nowIso: NOW,
    ...overrides,
  }
}

Deno.test('planDecisionExecution: HOLD always plans nothing, regardless of gate result', () => {
  const result = planDecisionExecution(baseInput())
  assertEquals(result, { kind: 'none' })
})

Deno.test('planDecisionExecution: CLOSE rejected by the gate plans nothing', () => {
  const proposal: ModelDecisionProposal = { asset: 'BTC', action: 'CLOSE', confidence: 0.9, horizonHours: null, reasons: [], invalidation: [] }
  const result = planDecisionExecution(baseInput({ proposal, gateResult: gateResult({ riskStatus: 'rejected', riskReason: 'no open position to close' }) }))
  assertEquals(result, { kind: 'none' })
})

Deno.test('planDecisionExecution: CLOSE approved computes a real closeResult via Step 4\'s closePosition, tagged agent_close', () => {
  const proposal: ModelDecisionProposal = { asset: 'BTC', action: 'CLOSE', confidence: 0.9, horizonHours: null, reasons: [], invalidation: [] }
  const result = planDecisionExecution(baseInput({ proposal, gateResult: gateResult({ riskStatus: 'approved' }), openPosition: position(), referencePrice: 108 }))
  if (result.kind !== 'close') throw new Error('expected a close plan')
  assertEquals(result.closeResult.trade.decisionId, '44444444-4444-4444-4444-444444444444')
  assertEquals(result.closeResult.trade.triggerReason, 'agent_close')
  // fillPrice = 108 * (1 - 5/10000) = 107.946 (SELL slippage moves price down); realizedPnl = fillPrice - entryPrice. Verified independently in Python before writing this.
  assertAlmostEquals(result.closeResult.realizedPnl, 7.946, 1e-9)
})

Deno.test('planDecisionExecution: CLOSE approved but no open position provided throws (a caller-consistency bug, not a valid state)', () => {
  const proposal: ModelDecisionProposal = { asset: 'BTC', action: 'CLOSE', confidence: 0.9, horizonHours: null, reasons: [], invalidation: [] }
  assertThrows(() => planDecisionExecution(baseInput({ proposal, gateResult: gateResult({ riskStatus: 'approved' }), openPosition: null })))
})

const openLongProposal: ModelDecisionProposal = {
  asset: 'BTC', action: 'OPEN_LONG', confidence: 0.74, stopLossPct: 0.03, takeProfitPct: 0.1, horizonHours: 24,
  reasons: [{ type: 'TECHNICAL', text: 'above EMA20' }], invalidation: [{ text: 'closes below EMA50' }],
}

Deno.test('planDecisionExecution: OPEN_LONG rejected by the gate plans nothing', () => {
  const result = planDecisionExecution(baseInput({ proposal: openLongProposal, gateResult: gateResult({ riskStatus: 'rejected', riskReason: 'confidence too low' }) }))
  assertEquals(result, { kind: 'none' })
})

Deno.test('planDecisionExecution: OPEN_LONG approved sizes notional from approvedSizePct * nav', () => {
  const gr = gateResult({ riskStatus: 'approved', approvedSizePct: 0.125, computedStopLossPrice: 97, computedTakeProfitPrice: 110 })
  const result = planDecisionExecution(baseInput({ proposal: openLongProposal, gateResult: gr, nav: 10_000, referencePrice: 100 }))
  if (result.kind !== 'open') throw new Error('expected an open plan')
  // notionalUsd = 0.125*10_000 = 1250; quantity = 1250/100 = 12.5; fillPrice = 100*(1+5/10000) = 100.05; costBasis = 12.5*100.05 = 1250.625. Verified independently in Python.
  assertAlmostEquals(result.openResult.position.costBasis, 1250.625, 1e-9)
  assertEquals(result.openResult.position.direction, 'long')
  assertEquals(result.openResult.position.stopLossPrice, 97)
  assertEquals(result.openResult.trade.decisionId, '44444444-4444-4444-4444-444444444444')
})

Deno.test('planDecisionExecution: OPEN_LONG clamped still executes (clamped is not a rejection)', () => {
  const gr = gateResult({ riskStatus: 'clamped', riskReason: 'clamped by single_trade cap', approvedSizePct: 0.2, computedStopLossPrice: 97, computedTakeProfitPrice: 110, sizeCapApplied: 'single_trade' })
  const result = planDecisionExecution(baseInput({ proposal: openLongProposal, gateResult: gr }))
  assertEquals(result.kind, 'open')
})

Deno.test('planDecisionExecution: OPEN_SHORT plans a short-direction position', () => {
  const proposal: ModelDecisionProposal = { ...openLongProposal, action: 'OPEN_SHORT' }
  const gr = gateResult({ riskStatus: 'approved', approvedSizePct: 0.1, computedStopLossPrice: 103, computedTakeProfitPrice: 90 })
  const result = planDecisionExecution(baseInput({ proposal, gateResult: gr }))
  if (result.kind !== 'open') throw new Error('expected an open plan')
  assertEquals(result.openResult.position.direction, 'short')
})

// --- Phase 2 (2026-09-22) — ADD --------------------------------------------

const addProposal: ModelDecisionProposal = {
  asset: 'BTC', action: 'ADD', confidence: 0.7, horizonHours: null,
  reasons: [{ type: 'TECHNICAL', text: 'Jev recommended adding.' }], invalidation: [], addMagnitude: 0.5,
}

Deno.test('planDecisionExecution: ADD rejected by the gate plans nothing', () => {
  const result = planDecisionExecution(baseInput({ proposal: addProposal, gateResult: gateResult({ riskStatus: 'rejected', riskReason: 'no room' }), openPosition: position() }))
  assertEquals(result, { kind: 'none' })
})

Deno.test('planDecisionExecution: ADD not_applicable (too small, normalized to HOLD upstream) plans nothing here either', () => {
  const result = planDecisionExecution(baseInput({ proposal: addProposal, gateResult: gateResult({ riskStatus: 'not_applicable', riskReason: 'too small' }), openPosition: position() }))
  assertEquals(result, { kind: 'none' })
})

Deno.test('planDecisionExecution: ADD approved computes a real addResult via addToPosition, using approvedAdjustNotionalUsd', () => {
  const gr = gateResult({ riskStatus: 'approved', approvedAdjustNotionalUsd: 250, computedStopLossPrice: 95, computedTakeProfitPrice: 110 })
  const result = planDecisionExecution(baseInput({ proposal: addProposal, gateResult: gr, openPosition: position({ quantity: 10, entryPrice: 100, costBasis: 1000 }), referencePrice: 100 }))
  if (result.kind !== 'add') throw new Error('expected an add plan')
  // addQuantity = 250/100 = 2.5; newQuantity = 12.5; newCostBasis = 1000+250=1250 (before fee/slippage on this reference-price sizing convention — see accounting.test.ts for the exact fee/slippage-inclusive numbers).
  assertAlmostEquals(result.addResult.updatedPosition.quantity, 12.5, 1e-9)
  assertEquals(result.addResult.trade.intent, 'ADD_LONG')
  assertEquals(result.addResult.trade.decisionId, '44444444-4444-4444-4444-444444444444')
})

Deno.test('planDecisionExecution: ADD clamped still executes (clamped is not a rejection)', () => {
  const gr = gateResult({ riskStatus: 'clamped', riskReason: 'clamped by cash', approvedAdjustNotionalUsd: 100, sizeCapApplied: 'cash', computedStopLossPrice: 95, computedTakeProfitPrice: 110 })
  const result = planDecisionExecution(baseInput({ proposal: addProposal, gateResult: gr, openPosition: position() }))
  assertEquals(result.kind, 'add')
})

Deno.test('planDecisionExecution: ADD approved but no open position provided throws', () => {
  const gr = gateResult({ riskStatus: 'approved', approvedAdjustNotionalUsd: 250 })
  assertThrows(() => planDecisionExecution(baseInput({ proposal: addProposal, gateResult: gr, openPosition: null })))
})

// --- Phase 2 — REDUCE -------------------------------------------------------

const reduceProposal: ModelDecisionProposal = {
  asset: 'BTC', action: 'REDUCE', confidence: 0.7, horizonHours: null,
  reasons: [{ type: 'TECHNICAL', text: 'Jev recommended trimming.' }], invalidation: [], reduceMagnitude: 0.5,
}

Deno.test('planDecisionExecution: REDUCE rejected by the gate plans nothing', () => {
  const result = planDecisionExecution(baseInput({ proposal: reduceProposal, gateResult: gateResult({ riskStatus: 'rejected' }), openPosition: position() }))
  assertEquals(result, { kind: 'none' })
})

Deno.test('planDecisionExecution: REDUCE approved computes a real reduceResult via reducePosition, using approvedReduceQuantity', () => {
  const gr = gateResult({ riskStatus: 'approved', approvedReduceQuantity: 5, computedStopLossPrice: 95, computedTakeProfitPrice: 110 })
  const result = planDecisionExecution(baseInput({ proposal: reduceProposal, gateResult: gr, openPosition: position({ quantity: 10, entryPrice: 100, costBasis: 1000 }), referencePrice: 100 }))
  if (result.kind !== 'reduce') throw new Error('expected a reduce plan')
  assertAlmostEquals(result.reduceResult.updatedPosition.quantity, 5, 1e-9)
  assertEquals(result.reduceResult.trade.intent, 'REDUCE_LONG')
  assertEquals(result.reduceResult.trade.realizedPnl !== null, true)
})

Deno.test('planDecisionExecution: REDUCE approved but no open position provided throws', () => {
  const gr = gateResult({ riskStatus: 'approved', approvedReduceQuantity: 5 })
  assertThrows(() => planDecisionExecution(baseInput({ proposal: reduceProposal, gateResult: gr, openPosition: null })))
})

// --- Phase 2 — MODIFY_PROTECTION --------------------------------------------

const modifyProtectionProposal: ModelDecisionProposal = {
  asset: 'BTC', action: 'MODIFY_PROTECTION', confidence: 0.7, horizonHours: null,
  reasons: [{ type: 'TECHNICAL', text: 'Jev recommended tightening.' }], invalidation: [],
  proposedStopLossPrice: 96, proposedTakeProfitPrice: null,
}

Deno.test('planDecisionExecution: MODIFY_PROTECTION rejected by the gate plans nothing — existing position untouched', () => {
  const result = planDecisionExecution(baseInput({ proposal: modifyProtectionProposal, gateResult: gateResult({ riskStatus: 'rejected', riskReason: 'would widen' }), openPosition: position() }))
  assertEquals(result, { kind: 'none' })
})

Deno.test('planDecisionExecution: MODIFY_PROTECTION approved updates only stopLossPrice/takeProfitPrice — quantity and entry stay untouched', () => {
  const gr = gateResult({ riskStatus: 'approved', computedStopLossPrice: 96, computedTakeProfitPrice: 110 })
  const existing = position({ quantity: 10, entryPrice: 100, costBasis: 1000, stopLossPrice: 90, takeProfitPrice: 110 })
  const result = planDecisionExecution(baseInput({ proposal: modifyProtectionProposal, gateResult: gr, openPosition: existing }))
  if (result.kind !== 'modifyProtection') throw new Error('expected a modifyProtection plan')
  assertEquals(result.updatedPosition.stopLossPrice, 96)
  assertEquals(result.updatedPosition.takeProfitPrice, 110)
  assertEquals(result.updatedPosition.quantity, 10, 'MODIFY_PROTECTION must never change quantity')
  assertEquals(result.updatedPosition.entryPrice, 100, 'MODIFY_PROTECTION must never change entry')
})

Deno.test('planDecisionExecution: MODIFY_PROTECTION approved but no open position provided throws', () => {
  const gr = gateResult({ riskStatus: 'approved', computedStopLossPrice: 96, computedTakeProfitPrice: 110 })
  assertThrows(() => planDecisionExecution(baseInput({ proposal: modifyProtectionProposal, gateResult: gr, openPosition: null })))
})
