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

function baseInput(overrides: Partial<DecisionPlanInput> = {}): DecisionPlanInput {
  return {
    asset: 'BTC',
    portfolioId: '22222222-2222-2222-2222-222222222222',
    proposal: { asset: 'BTC', action: 'HOLD', confidence: 0.5, horizonHours: null, reasons: [], invalidation: [] },
    gateResult: { riskStatus: 'not_applicable', riskReason: null, approvedSizePct: null, computedStopLossPrice: null, computedTakeProfitPrice: null, sizeCapApplied: null },
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
  const gateResult: RiskGateResult = { riskStatus: 'rejected', riskReason: 'no open position to close', approvedSizePct: null, computedStopLossPrice: null, computedTakeProfitPrice: null, sizeCapApplied: null }
  const result = planDecisionExecution(baseInput({ proposal, gateResult }))
  assertEquals(result, { kind: 'none' })
})

Deno.test('planDecisionExecution: CLOSE approved computes a real closeResult via Step 4\'s closePosition, tagged agent_close', () => {
  const proposal: ModelDecisionProposal = { asset: 'BTC', action: 'CLOSE', confidence: 0.9, horizonHours: null, reasons: [], invalidation: [] }
  const gateResult: RiskGateResult = { riskStatus: 'approved', riskReason: null, approvedSizePct: null, computedStopLossPrice: null, computedTakeProfitPrice: null, sizeCapApplied: null }
  const result = planDecisionExecution(baseInput({ proposal, gateResult, openPosition: position(), referencePrice: 108 }))
  if (result.kind !== 'close') throw new Error('expected a close plan')
  assertEquals(result.closeResult.trade.decisionId, '44444444-4444-4444-4444-444444444444')
  assertEquals(result.closeResult.trade.triggerReason, 'agent_close')
  // fillPrice = 108 * (1 - 5/10000) = 107.946 (SELL slippage moves price down); realizedPnl = fillPrice - entryPrice. Verified independently in Python before writing this.
  assertAlmostEquals(result.closeResult.realizedPnl, 7.946, 1e-9)
})

Deno.test('planDecisionExecution: CLOSE approved but no open position provided throws (a caller-consistency bug, not a valid state)', () => {
  const proposal: ModelDecisionProposal = { asset: 'BTC', action: 'CLOSE', confidence: 0.9, horizonHours: null, reasons: [], invalidation: [] }
  const gateResult: RiskGateResult = { riskStatus: 'approved', riskReason: null, approvedSizePct: null, computedStopLossPrice: null, computedTakeProfitPrice: null, sizeCapApplied: null }
  assertThrows(() => planDecisionExecution(baseInput({ proposal, gateResult, openPosition: null })))
})

const openLongProposal: ModelDecisionProposal = {
  asset: 'BTC', action: 'OPEN_LONG', confidence: 0.74, stopLossPct: 0.03, takeProfitPct: 0.1, horizonHours: 24,
  reasons: [{ type: 'TECHNICAL', text: 'above EMA20' }], invalidation: [{ text: 'closes below EMA50' }],
}

Deno.test('planDecisionExecution: OPEN_LONG rejected by the gate plans nothing', () => {
  const gateResult: RiskGateResult = { riskStatus: 'rejected', riskReason: 'confidence too low', approvedSizePct: null, computedStopLossPrice: null, computedTakeProfitPrice: null, sizeCapApplied: null }
  const result = planDecisionExecution(baseInput({ proposal: openLongProposal, gateResult }))
  assertEquals(result, { kind: 'none' })
})

Deno.test('planDecisionExecution: OPEN_LONG approved sizes notional from approvedSizePct * nav', () => {
  const gateResult: RiskGateResult = { riskStatus: 'approved', riskReason: null, approvedSizePct: 0.125, computedStopLossPrice: 97, computedTakeProfitPrice: 110, sizeCapApplied: null }
  const result = planDecisionExecution(baseInput({ proposal: openLongProposal, gateResult, nav: 10_000, referencePrice: 100 }))
  if (result.kind !== 'open') throw new Error('expected an open plan')
  // notionalUsd = 0.125*10_000 = 1250; quantity = 1250/100 = 12.5; fillPrice = 100*(1+5/10000) = 100.05; costBasis = 12.5*100.05 = 1250.625. Verified independently in Python.
  assertAlmostEquals(result.openResult.position.costBasis, 1250.625, 1e-9)
  assertEquals(result.openResult.position.direction, 'long')
  assertEquals(result.openResult.position.stopLossPrice, 97)
  assertEquals(result.openResult.trade.decisionId, '44444444-4444-4444-4444-444444444444')
})

Deno.test('planDecisionExecution: OPEN_LONG clamped still executes (clamped is not a rejection)', () => {
  const gateResult: RiskGateResult = { riskStatus: 'clamped', riskReason: 'clamped by single_trade cap', approvedSizePct: 0.2, computedStopLossPrice: 97, computedTakeProfitPrice: 110, sizeCapApplied: 'single_trade' }
  const result = planDecisionExecution(baseInput({ proposal: openLongProposal, gateResult }))
  assertEquals(result.kind, 'open')
})

Deno.test('planDecisionExecution: OPEN_SHORT plans a short-direction position', () => {
  const proposal: ModelDecisionProposal = { ...openLongProposal, action: 'OPEN_SHORT' }
  const gateResult: RiskGateResult = { riskStatus: 'approved', riskReason: null, approvedSizePct: 0.1, computedStopLossPrice: 103, computedTakeProfitPrice: 90, sizeCapApplied: null }
  const result = planDecisionExecution(baseInput({ proposal, gateResult }))
  if (result.kind !== 'open') throw new Error('expected an open plan')
  assertEquals(result.openResult.position.direction, 'short')
})
