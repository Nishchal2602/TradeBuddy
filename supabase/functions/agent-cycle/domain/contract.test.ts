// Verifies the INTERNAL CONSISTENCY of contract.fixtures.ts — there is no
// production code yet (Step 0 of the position-model plan). These tests
// recompute every fixture's expected numbers from the accounting formulas
// in the plan/contract, independently of how the fixture file itself was
// transcribed, so a slip between the Python hand-check and the fixture
// file would be caught here too.
//
// Steps 3-5 re-run these same fixture arrays against real implementations
// — this file is the acceptance criteria those steps must satisfy.

import { assertEquals, assertAlmostEquals } from 'jsr:@std/assert@1'
import {
  STATE_TRANSITIONS,
  ACCOUNTING_SCENARIOS,
  SL_TP_ORDERING_CASES,
  PROVENANCE_CASES,
  CONCURRENT_CLOSE_RACE,
  exhaustionPrice,
  type PositionState,
  type Action,
} from './contract.fixtures.ts'

// ============================================================================
// 1. State-machine totality
// ============================================================================

Deno.test('state transitions: all 12 (state, action) pairs are present exactly once', () => {
  const states: PositionState[] = ['FLAT', 'LONG', 'SHORT']
  const actions: Action[] = ['OPEN_LONG', 'OPEN_SHORT', 'HOLD', 'CLOSE']

  const seen = new Set<string>()
  for (const c of STATE_TRANSITIONS) {
    const key = `${c.state}:${c.action}`
    assertEquals(seen.has(key), false, `duplicate case for ${key}`)
    seen.add(key)
  }

  for (const state of states) {
    for (const action of actions) {
      assertEquals(seen.has(`${state}:${action}`), true, `missing case for ${state}:${action}`)
    }
  }
  assertEquals(STATE_TRANSITIONS.length, 12)
})

Deno.test('state transitions: every rejected case states a reason', () => {
  for (const c of STATE_TRANSITIONS) {
    if (c.outcome === 'rejected') {
      assertEquals(typeof c.rejectionReason, 'string', `${c.state}:${c.action} rejected with no reason`)
    }
  }
})

Deno.test('state transitions: FLAT allows exactly OPEN_LONG/OPEN_SHORT/HOLD; LONG and SHORT allow exactly HOLD/CLOSE', () => {
  const validFor = (state: PositionState) =>
    STATE_TRANSITIONS.filter((c) => c.state === state && c.outcome === 'valid').map((c) => c.action).sort()

  assertEquals(validFor('FLAT'), ['HOLD', 'OPEN_LONG', 'OPEN_SHORT'])
  assertEquals(validFor('LONG'), ['CLOSE', 'HOLD'])
  assertEquals(validFor('SHORT'), ['CLOSE', 'HOLD'])
})

// ============================================================================
// 2. Accounting identities — recomputed from formulas, not copied from the
//    fixture's own `expected` block
// ============================================================================

function computeLong(entry: number, notional: number, feeRate: number, fillPrice: number) {
  const quantity = notional / entry
  const feeOpen = notional * feeRate
  const cashAfterOpen = -notional - feeOpen // delta from starting cash
  const costBasis = notional

  const grossAtClose = quantity * fillPrice
  const feeClose = grossAtClose * feeRate
  const realizedPnl = (fillPrice - entry) * quantity
  const cashDeltaTotal = cashAfterOpen + grossAtClose - feeClose

  return { quantity, feeOpen, cashAfterOpenDelta: cashAfterOpen, costBasis, feeClose, cashDeltaTotal, realizedPnl }
}

function computeShort(entry: number, notional: number, feeRate: number, fillPrice: number) {
  const quantity = notional / entry
  const feeOpen = notional * feeRate
  const cashAfterOpen = -notional - feeOpen
  const costBasis = notional

  const realizedPnl = (entry - fillPrice) * quantity
  const feeClose = quantity * fillPrice * feeRate
  // cash += notional + realizedPnl - feeClose, applied on top of cashAfterOpen
  const cashDeltaTotal = cashAfterOpen + notional + realizedPnl - feeClose

  return { quantity, feeOpen, cashAfterOpenDelta: cashAfterOpen, costBasis, feeClose, cashDeltaTotal, realizedPnl }
}

Deno.test('accounting scenarios: every expected value matches recomputation from formulas', () => {
  for (const s of ACCOUNTING_SCENARIOS) {
    const computed = s.direction === 'long'
      ? computeLong(s.entryPrice, s.notional, s.feeRate, s.fillPrice)
      : computeShort(s.entryPrice, s.notional, s.feeRate, s.fillPrice)

    const cashAfterOpen = s.startingCash + computed.cashAfterOpenDelta
    const cashAfterClose = s.startingCash + computed.cashDeltaTotal

    assertAlmostEquals(computed.quantity, s.expected.quantity, 1e-9, `${s.name}: quantity`)
    assertAlmostEquals(computed.feeOpen, s.expected.feeOpen, 1e-9, `${s.name}: feeOpen`)
    assertAlmostEquals(cashAfterOpen, s.expected.cashAfterOpen, 1e-9, `${s.name}: cashAfterOpen`)
    assertAlmostEquals(computed.costBasis, s.expected.costBasis, 1e-9, `${s.name}: costBasis`)
    assertAlmostEquals(computed.feeClose, s.expected.feeClose, 1e-9, `${s.name}: feeClose`)
    assertAlmostEquals(cashAfterClose, s.expected.cashAfterClose, 1e-9, `${s.name}: cashAfterClose`)
    assertAlmostEquals(computed.realizedPnl, s.expected.realizedPnl, 1e-9, `${s.name}: realizedPnl`)
  }
})

Deno.test('accounting scenarios: the identity cashAfterClose - startingCash == realizedPnl - totalFees holds for every scenario', () => {
  for (const s of ACCOUNTING_SCENARIOS) {
    const totalFees = s.expected.feeOpen + s.expected.feeClose
    const lhs = s.expected.cashAfterClose - s.startingCash
    const rhs = s.expected.realizedPnl - totalFees // no slippage modeled in these scenarios
    assertAlmostEquals(lhs, rhs, 1e-9, `${s.name}: identity`)
  }
})

Deno.test('accounting scenarios: cash never goes negative in any scenario', () => {
  for (const s of ACCOUNTING_SCENARIOS) {
    if (s.expected.cashAfterOpen < 0) throw new Error(`${s.name}: cashAfterOpen went negative`)
    if (s.expected.cashAfterClose < 0) throw new Error(`${s.name}: cashAfterClose went negative`)
  }
})

Deno.test('accounting scenarios: short direction never realizes a loss beyond -notional, even when a gap scenario is present', () => {
  const shorts = ACCOUNTING_SCENARIOS.filter((s) => s.direction === 'short')
  for (const s of shorts) {
    if (s.expected.realizedPnl < -s.notional - 1e-9) {
      throw new Error(`${s.name}: realizedPnl ${s.expected.realizedPnl} exceeds -notional ${-s.notional} — collateral exhaustion clamp violated`)
    }
  }
})

Deno.test('gap-through scenario: fillPrice is clamped to the exhaustion price, not the observed price', () => {
  const gapCase = ACCOUNTING_SCENARIOS.find((s) => s.observedPrice !== undefined)
  if (!gapCase) throw new Error('no gap-through fixture present')

  const expectedExhaustion = exhaustionPrice(gapCase.entryPrice)
  assertEquals(gapCase.fillPrice, expectedExhaustion, 'fillPrice must equal the exhaustion price')
  assertEquals(gapCase.observedPrice! > expectedExhaustion, true, 'this fixture only means something if the observed price actually overshot')
  assertEquals(gapCase.expected.realizedPnl, -gapCase.notional, 'realized loss must be clamped at exactly -notional')

  // The specific regression this guards: naively using the OBSERVED price
  // instead of the clamped fillPrice would realize a loss beyond collateral.
  const naiveRealizedPnl = (gapCase.entryPrice - gapCase.observedPrice!) * gapCase.expected.quantity
  assertEquals(naiveRealizedPnl < gapCase.expected.realizedPnl, true, 'sanity: the naive (wrong) computation really would have been worse than the clamped one')
})

Deno.test('exhaustionPrice is exactly 2x entry', () => {
  assertEquals(exhaustionPrice(100), 200)
  assertEquals(exhaustionPrice(76851), 153702)
})

// ============================================================================
// 3. SL/TP ordering
// ============================================================================

function isValidSlTp(direction: 'long' | 'short', entry: number, stopLoss: number, takeProfit: number): boolean {
  if (direction === 'long') return stopLoss < entry && entry < takeProfit

  const orderingValid = takeProfit < entry && entry < stopLoss
  // A short's stop cannot sit at or beyond the collateral-exhaustion price
  // (2x entry) — exhaustion would fire first, or simultaneously, making the
  // stop unreachable. This is a real constraint from the contract, not just
  // an ordering check, and belongs here because a real validator would
  // apply both together as one "is this SL/TP proposal acceptable" step.
  const withinExhaustionCeiling = stopLoss < exhaustionPrice(entry)
  return orderingValid && withinExhaustionCeiling
}

Deno.test('SL/TP ordering: every case matches the direction-specific rule', () => {
  for (const c of SL_TP_ORDERING_CASES) {
    const valid = isValidSlTp(c.direction, c.entry, c.stopLoss, c.takeProfit)
    const expectedValid = c.outcome === 'valid'
    assertEquals(valid, expectedValid, `${c.direction} entry=${c.entry} SL=${c.stopLoss} TP=${c.takeProfit} (${c.note})`)
  }
})

Deno.test('SL/TP ordering: both directions have at least one valid and multiple rejected cases', () => {
  for (const direction of ['long', 'short'] as const) {
    const cases = SL_TP_ORDERING_CASES.filter((c) => c.direction === direction)
    const validCount = cases.filter((c) => c.outcome === 'valid').length
    const rejectedCount = cases.filter((c) => c.outcome === 'rejected').length
    assertEquals(validCount >= 1, true, `${direction}: no valid case`)
    assertEquals(rejectedCount >= 3, true, `${direction}: too few rejected cases to be meaningful coverage`)
  }
})

Deno.test('SL/TP ordering: the short 100%-distance stop (exactly at the exhaustion price) is rejected', () => {
  const c = SL_TP_ORDERING_CASES.find((c) => c.direction === 'short' && c.stopLoss === exhaustionPrice(c.entry))
  if (!c) throw new Error('no fixture covers a short SL at exactly the exhaustion price')
  assertEquals(c.outcome, 'rejected')
})

// ============================================================================
// 4. Provenance combinations
// ============================================================================

function isValidProvenance(intent: string, hasDecisionId: boolean, triggerReason: string | null): boolean {
  const isOpen = intent === 'OPEN_LONG' || intent === 'OPEN_SHORT'
  if (isOpen) return hasDecisionId && triggerReason === null
  // isClose
  if (hasDecisionId) return triggerReason === 'agent_close'
  return triggerReason === 'stop_loss' || triggerReason === 'take_profit' || triggerReason === 'collateral_exhausted'
}

Deno.test('provenance: every case matches the 3-legal-combination rule', () => {
  for (const c of PROVENANCE_CASES) {
    const valid = isValidProvenance(c.intent, c.hasDecisionId, c.triggerReason)
    const expectedValid = c.outcome === 'valid'
    assertEquals(
      valid,
      expectedValid,
      `intent=${c.intent} hasDecisionId=${c.hasDecisionId} triggerReason=${c.triggerReason} (${c.note})`,
    )
  }
})

Deno.test('provenance: exactly 3 distinct legal shapes exist, matching the plan\'s trades_provenance_valid constraint', () => {
  const legalShapes = new Set(
    PROVENANCE_CASES
      .filter((c) => c.outcome === 'valid')
      .map((c) => {
        const isOpen = c.intent === 'OPEN_LONG' || c.intent === 'OPEN_SHORT'
        if (isOpen) return 'open'
        return c.hasDecisionId ? 'agent_close' : 'automatic_close'
      }),
  )
  assertEquals(legalShapes.size, 3)
  assertEquals([...legalShapes].sort(), ['agent_close', 'automatic_close', 'open'])
})

Deno.test('provenance: an agent-initiated close legitimately carries BOTH decision_id and trigger_reason (the bug this fixture set exists to prevent)', () => {
  const agentCloseCase = PROVENANCE_CASES.find((c) => c.note === 'agent-initiated close')
  if (!agentCloseCase) throw new Error('no agent-initiated close fixture found')
  assertEquals(agentCloseCase.hasDecisionId, true)
  assertEquals(agentCloseCase.triggerReason, 'agent_close')
  assertEquals(agentCloseCase.outcome, 'valid')
})

// ============================================================================
// 5. Concurrent-close race
// ============================================================================

Deno.test('concurrent-close race: both interleavings are present and are mutual opposites', () => {
  assertEquals(CONCURRENT_CLOSE_RACE.length, 2)
  const outcomes = CONCURRENT_CLOSE_RACE.map((r) => r.expected.agentDecisionOutcome).sort()
  assertEquals(outcomes, ['approved', 'rejected_already_closed'])
})

Deno.test('concurrent-close race: every scenario resolves to exactly one close, one trade, one realized P&L', () => {
  for (const r of CONCURRENT_CLOSE_RACE) {
    assertEquals(r.expected.positionCloses, 1, r.name)
    assertEquals(r.expected.closeTrades, 1, r.name)
    assertEquals(r.expected.realizedPnlEntries, 1, r.name)
  }
})

Deno.test('concurrent-close race: the winner and loser outcomes are consistent with each other in every scenario', () => {
  for (const r of CONCURRENT_CLOSE_RACE) {
    const agentWon = r.expected.agentDecisionOutcome === 'approved'
    const monitorWon = r.expected.monitorOutcome === 'closed_position'
    // Exactly one side can have actually performed the close.
    assertEquals(agentWon !== monitorWon, true, r.name)
  }
})

Deno.test('concurrent-close race: every sequence ends with the loser explicitly detecting the loss, not silently double-acting', () => {
  for (const r of CONCURRENT_CLOSE_RACE) {
    const lastEvent = r.sequence[r.sequence.length - 1]!
    const mentionsDetection = /already closed|no rows affected|no-?op/i.test(lastEvent.event)
    assertEquals(mentionsDetection, true, `${r.name}: final event should show the losing side detecting the race, got: "${lastEvent.event}"`)
  }
})
