import { assertAlmostEquals, assertEquals, assertStrictEquals } from 'jsr:@std/assert@1'
import { applyManagementOutcome } from './apply-management.ts'
import type { ManagementPositionContext } from './apply-management.ts'
import { evaluateRiskGate } from '../../../../src/shared/risk/gate.ts'
import type { RiskGateContext } from '../../../../src/shared/risk/gate.ts'
import type { ModelDecisionProposal } from '../../../../src/shared/decisions/types.ts'
import type { ManagementOutcome } from '../model/jev/provider.ts'

// ⭐ This file is the containment proof for the management layer, the same
// role apply-veto.test.ts plays for the veto: it proves ADD/REDUCE never
// carry anything but a bounded fraction (never a dollar figure or a
// price), and MODIFY_PROTECTION's proposed prices are computed correctly
// — never trusted from Jev directly.

function holdCandidate(overrides: Partial<ModelDecisionProposal> = {}): ModelDecisionProposal {
  return {
    asset: 'BTC', action: 'HOLD', confidence: 1, horizonHours: null,
    reasons: [{ type: 'TECHNICAL', text: 'Daily close still above the 50-day MA — regime unchanged' }],
    invalidation: [{ text: 'Daily close at or below the 50-day moving average' }],
    ...overrides,
  } as ModelDecisionProposal
}

function outcome(overrides: Partial<ManagementOutcome> = {}): ManagementOutcome {
  return {
    asset: 'BTC', action: 'HOLD', actionConfidence: 0.8,
    actionProbabilities: { HOLD: 0.8, ADD: 0.1, REDUCE: 0.05, CLOSE: 0.03, MODIFY_PROTECTION: 0.02 },
    addMagnitude: 0.5, reduceMagnitude: 0.5, stopIntent: 'KEEP', targetIntent: 'KEEP',
    ...overrides,
  }
}

const LONG_POSITION: ManagementPositionContext = {
  direction: 'long', entryPrice: 100, currentPrice: 120, stopLossPrice: 90, takeProfitPrice: 180,
  atrPct: 2.5, minStopLossPct: 0.005,
}

const SHORT_POSITION: ManagementPositionContext = {
  direction: 'short', entryPrice: 100, currentPrice: 90, stopLossPrice: 110, takeProfitPrice: 50,
  atrPct: 2.5, minStopLossPct: 0.005,
}

// --- HOLD ------------------------------------------------------------------

Deno.test('applyManagementOutcome: HOLD returns the exact same candidate object by reference', () => {
  const candidate = holdCandidate()
  const result = applyManagementOutcome(candidate, 'BTC', outcome({ action: 'HOLD' }), LONG_POSITION)
  assertStrictEquals(result, candidate)
})

// --- CLOSE -------------------------------------------------------------------

Deno.test('applyManagementOutcome: CLOSE builds a CLOSE proposal, never the original HOLD', () => {
  const candidate = holdCandidate()
  const result = applyManagementOutcome(candidate, 'BTC', outcome({ action: 'CLOSE', actionConfidence: 0.9 }), LONG_POSITION)
  assertEquals(result.action, 'CLOSE')
  assertEquals(result === candidate, false)
  assertEquals(result.confidence, 0.9, "Jev's own actionConfidence is carried onto the proposal")
})

// --- ADD — the containment proof: only ever a bounded fraction ------------

Deno.test('applyManagementOutcome: ADD carries ONLY addMagnitude — no price, no dollar figure, nothing else Jev could smuggle a number through', () => {
  const result = applyManagementOutcome(holdCandidate(), 'BTC', outcome({ action: 'ADD', addMagnitude: 0.75 }), LONG_POSITION)
  assertEquals(result.action, 'ADD')
  if (result.action !== 'ADD') throw new Error('unreachable')
  assertEquals(result.addMagnitude, 0.75)
  // The discriminated union's own .strict() schema is the deeper
  // guarantee (src/shared/decisions/types.ts) — this just confirms the
  // TS shape carries nothing extra at this layer.
  assertEquals(Object.keys(result).sort(), ['action', 'addMagnitude', 'asset', 'confidence', 'horizonHours', 'invalidation', 'reasons'])
})

Deno.test('applyManagementOutcome: REDUCE carries ONLY reduceMagnitude, the symmetric containment guarantee', () => {
  const result = applyManagementOutcome(holdCandidate(), 'BTC', outcome({ action: 'REDUCE', reduceMagnitude: 0.25 }), LONG_POSITION)
  assertEquals(result.action, 'REDUCE')
  if (result.action !== 'REDUCE') throw new Error('unreachable')
  assertEquals(result.reduceMagnitude, 0.25)
  assertEquals(Object.keys(result).sort(), ['action', 'asset', 'confidence', 'horizonHours', 'invalidation', 'reasons', 'reduceMagnitude'])
})

// --- MODIFY_PROTECTION — deterministic price computation --------------------

Deno.test('applyManagementOutcome: TIGHTEN_TO_BREAKEVEN computes the tightest LEGAL stop just inside entry, never entry itself', () => {
  const result = applyManagementOutcome(holdCandidate(), 'BTC', outcome({ action: 'MODIFY_PROTECTION', stopIntent: 'TIGHTEN_TO_BREAKEVEN', targetIntent: 'KEEP' }), LONG_POSITION)
  assertEquals(result.action, 'MODIFY_PROTECTION')
  if (result.action !== 'MODIFY_PROTECTION') throw new Error('unreachable')
  // entry(100) * (1 - 0.005) = 99.5 — strictly less than entry, satisfying positions_sl_tp_ordering_valid's strict inequality.
  assertEquals(result.proposedStopLossPrice, 99.5)
  assertEquals(result.proposedStopLossPrice! < 100, true, 'never proposes literal breakeven (SL === entry), which is invalid at the DB level')
  assertEquals(result.proposedTakeProfitPrice, null, 'KEEP means no change requested for that leg')
})

Deno.test('applyManagementOutcome: TIGHTEN_TO_BREAKEVEN on a SHORT moves the stop DOWN toward entry, the symmetric direction', () => {
  const result = applyManagementOutcome(holdCandidate(), 'BTC', outcome({ action: 'MODIFY_PROTECTION', stopIntent: 'TIGHTEN_TO_BREAKEVEN', targetIntent: 'KEEP' }), SHORT_POSITION)
  if (result.action !== 'MODIFY_PROTECTION') throw new Error('unreachable')
  // entry(100) * (1 + 0.005) = 100.5 — strictly greater than entry, correct for a short.
  assertAlmostEquals(result.proposedStopLossPrice!, 100.5, 1e-9)
  assertEquals(result.proposedStopLossPrice! > 100, true)
})

Deno.test('applyManagementOutcome: MOVE_CLOSER on a long moves TP toward price by exactly one ATR', () => {
  // atrPrice = (2.5/100)*120 = 3. MOVE_CLOSER on a long: TP - atrPrice = 180 - 3 = 177.
  const result = applyManagementOutcome(holdCandidate(), 'BTC', outcome({ action: 'MODIFY_PROTECTION', stopIntent: 'KEEP', targetIntent: 'MOVE_CLOSER' }), LONG_POSITION)
  if (result.action !== 'MODIFY_PROTECTION') throw new Error('unreachable')
  assertEquals(result.proposedTakeProfitPrice, 177)
  assertEquals(result.proposedStopLossPrice, null)
})

Deno.test('applyManagementOutcome: MOVE_OUT on a long moves TP away from price by exactly one ATR', () => {
  // 180 + 3 = 183.
  const result = applyManagementOutcome(holdCandidate(), 'BTC', outcome({ action: 'MODIFY_PROTECTION', stopIntent: 'KEEP', targetIntent: 'MOVE_OUT' }), LONG_POSITION)
  if (result.action !== 'MODIFY_PROTECTION') throw new Error('unreachable')
  assertEquals(result.proposedTakeProfitPrice, 183)
})

Deno.test('applyManagementOutcome: MOVE_CLOSER on a SHORT moves TP UP toward price (the symmetric direction) by one ATR', () => {
  // atrPrice = (2.5/100)*90 = 2.25. Short TP is BELOW price; MOVE_CLOSER means moving toward price, i.e. UP: 50 + 2.25 = 52.25.
  const result = applyManagementOutcome(holdCandidate(), 'BTC', outcome({ action: 'MODIFY_PROTECTION', stopIntent: 'KEEP', targetIntent: 'MOVE_CLOSER' }), SHORT_POSITION)
  if (result.action !== 'MODIFY_PROTECTION') throw new Error('unreachable')
  assertEquals(result.proposedTakeProfitPrice, 52.25)
})

Deno.test('applyManagementOutcome: both legs KEEP normalizes to the original HOLD candidate, not a no-op MODIFY_PROTECTION', () => {
  const candidate = holdCandidate()
  const result = applyManagementOutcome(candidate, 'BTC', outcome({ action: 'MODIFY_PROTECTION', stopIntent: 'KEEP', targetIntent: 'KEEP' }), LONG_POSITION)
  assertStrictEquals(result, candidate)
})

Deno.test('applyManagementOutcome: both legs proposed together (tighten stop AND move target) produces one MODIFY_PROTECTION with both prices set', () => {
  const result = applyManagementOutcome(holdCandidate(), 'BTC', outcome({ action: 'MODIFY_PROTECTION', stopIntent: 'TIGHTEN_TO_BREAKEVEN', targetIntent: 'MOVE_OUT' }), LONG_POSITION)
  if (result.action !== 'MODIFY_PROTECTION') throw new Error('unreachable')
  assertEquals(result.proposedStopLossPrice, 99.5)
  assertEquals(result.proposedTakeProfitPrice, 183)
})

// --- Confidence carried, never gated here (that's the gate's business, and it doesn't gate on it either) ---

Deno.test('applyManagementOutcome: actionConfidence is carried onto every non-HOLD proposal, even when low — this function never suppresses based on it', () => {
  const result = applyManagementOutcome(holdCandidate(), 'BTC', outcome({ action: 'CLOSE', actionConfidence: 0.12 }), LONG_POSITION)
  assertEquals(result.action, 'CLOSE')
  assertEquals(result.confidence, 0.12, 'a low-confidence CLOSE still executes — this is the specific regression the migration plan v1 exists to avoid')
})

// --- Phase 2.1 (2026-09-23), test 4: "bullish thesis intact must not
// prevent management processing" -------------------------------------------
//
// Regression protection for the actual invariant Phase 2.1 is about: an
// OPEN position whose deterministic thesis is INTACT (regime still UP,
// Pass 1's own candidate is HOLD — exactly what holdCandidate() below
// represents) must still let every one of REDUCE/CLOSE/ADD/
// MODIFY_PROTECTION run the FULL chain — applyManagementOutcome ->
// deterministic sizing/price -> evaluateRiskGate — and receive a real
// verdict, not be short-circuited because "the thesis says stay in."
// collect-candidates.test.ts already proves the candidate reaches this
// far; these tests prove what happens once it does.

// One shared, generous gate context so every action in this block is
// judged on the SAME open, in-profit, thesis-intact position — entry 100,
// current price 120 (up 20%), matching LONG_POSITION above exactly so
// there's one number system across this whole file. Caps are
// deliberately wide (not the tight SEEDED_BOUNDS other gate tests use)
// so a real verdict — not an incidental cap/bound rejection unrelated to
// what's being tested — is what each assertion actually exercises.
function intactThesisGateContext(overrides: Partial<RiskGateContext> = {}): RiskGateContext {
  return {
    currentState: 'LONG',
    entryPrice: 120, // CURRENT market price (gate.ts's naming) — the position's own entry (100) lives on openPosition below
    nav: 10_000,
    cash: 10_000,
    effectiveMinConfidence: 0,
    effectiveRiskBudgetPct: 0.05,
    effectiveSingleTradeCapPct: 0.50,
    effectiveAssetExposureCapPct: 0.50,
    slTpBounds: { minStopLossPct: 0.005, maxStopLossPct: 0.50, minTakeProfitPct: 0.005, maxTakeProfitPct: 0.90 },
    currentAssetExposureUsd: 120,
    stopOutReentryBlockMinutes: 360,
    recentStopLossClose: null,
    nowIso: '2026-09-23T12:00:00.000Z',
    portfolioRiskCeilingUsd: 100_000,
    otherOpenPositionsRiskAtStopUsd: 0,
    maxTotalNotionalUsd: 100_000,
    otherSameDirectionNotionalUsd: 0,
    peakNav: 10_000,
    drawdownBreakerFloorPct: 0.90,
    openPosition: { quantity: 1, entryPrice: 100, stopLossPrice: 90, takeProfitPrice: 180 },
    feeBps: 10,
    slippageBps: 5,
    minTradeNotionalPct: 0.001,
    minTradeNotionalUsd: 1,
    ...overrides,
  }
}

Deno.test('Phase 2.1 test 4 — REDUCE: intact-thesis HOLD -> management normalization -> deterministic sizing -> risk gate -> a real approved verdict', () => {
  const candidate = holdCandidate() // the thesis is INTACT — daily close still above the 50-day MA
  const managed = applyManagementOutcome(candidate, 'BTC', outcome({ action: 'REDUCE', reduceMagnitude: 0.25 }), LONG_POSITION)
  assertEquals(managed.action, 'REDUCE', 'an intact thesis must not have silently kept this as HOLD')

  const result = evaluateRiskGate(managed, intactThesisGateContext())
  assertEquals(result.riskStatus, 'approved', 'REDUCE must reach a real deterministic verdict, not be blocked by the thesis still being intact')
  assertAlmostEquals(result.approvedReduceQuantity!, 0.25, 1e-9)
  assertAlmostEquals(result.approvedAdjustNotionalUsd!, 30, 1e-9) // 0.25 qty * 120 current price
})

Deno.test('Phase 2.1 test 4 — CLOSE: intact-thesis HOLD -> management normalization -> risk gate -> approved (exits are never blocked, thesis or no)', () => {
  const candidate = holdCandidate()
  const managed = applyManagementOutcome(candidate, 'BTC', outcome({ action: 'CLOSE', actionConfidence: 0.7 }), LONG_POSITION)
  assertEquals(managed.action, 'CLOSE')

  const result = evaluateRiskGate(managed, intactThesisGateContext())
  assertEquals(result.riskStatus, 'approved', "an intact bullish thesis is not a reason to reject a model-originated CLOSE — trading-domain-contract.md's 'exits must always be actionable' applies here too")
})

Deno.test('Phase 2.1 test 4 — ADD: intact-thesis HOLD -> bounded magnitude -> risk-derived ceiling -> caps applied -> approved', () => {
  const candidate = holdCandidate()
  const managed = applyManagementOutcome(candidate, 'BTC', outcome({ action: 'ADD', addMagnitude: 0.5 }), LONG_POSITION)
  assertEquals(managed.action, 'ADD')
  if (managed.action !== 'ADD') throw new Error('unreachable')
  assertEquals(managed.addMagnitude, 0.5, 'still only a bounded fraction reaching the gate, never a dollar figure')

  const result = evaluateRiskGate(managed, intactThesisGateContext())
  assertEquals(result.riskStatus, 'approved', 'an intact thesis is precisely the case ADD exists for — additional conviction on a working trade')
  // riskBasedMaxAdd = (nav*riskBudgetPct / |entry-stop|) * entry = (500/30)*120 = 2000; * addMagnitude(0.5) = 1000.
  assertAlmostEquals(result.approvedAdjustNotionalUsd!, 1000, 1e-6)
})

Deno.test('Phase 2.1 test 4 — MODIFY_PROTECTION: intact-thesis HOLD -> tighten-only stop intent -> deterministic price -> risk gate validates -> approved, quantity untouched', () => {
  const candidate = holdCandidate()
  const managed = applyManagementOutcome(candidate, 'BTC', outcome({ action: 'MODIFY_PROTECTION', stopIntent: 'TIGHTEN_TO_BREAKEVEN', targetIntent: 'KEEP' }), LONG_POSITION)
  assertEquals(managed.action, 'MODIFY_PROTECTION')
  if (managed.action !== 'MODIFY_PROTECTION') throw new Error('unreachable')
  assertEquals(managed.proposedStopLossPrice, 99.5)

  const result = evaluateRiskGate(managed, intactThesisGateContext())
  assertEquals(result.riskStatus, 'approved')
  assertEquals(result.computedStopLossPrice, 99.5, 'the tightened stop is what the gate leaves in place')
  assertEquals(result.computedTakeProfitPrice, 180, 'KEEP on the target leg — the existing TP is preserved unchanged')
  assertEquals(result.approvedSizePct, null, 'MODIFY_PROTECTION never touches size')
  assertEquals(result.approvedAdjustNotionalUsd, null, 'and never touches quantity')
})
