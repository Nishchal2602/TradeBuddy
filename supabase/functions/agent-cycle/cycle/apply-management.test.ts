import { assertAlmostEquals, assertEquals, assertStrictEquals } from 'jsr:@std/assert@1'
import { applyManagementOutcome } from './apply-management.ts'
import type { ManagementPositionContext } from './apply-management.ts'
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
