import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import { buildCandidateProposal, stopLossPctFor, takeProfitPctFor, vetoedHoldProposal } from './rules.ts'
import { ModelDecisionProposal } from '../../../../src/shared/decisions/types.ts'
import type { RegimeResult } from '../../../../src/shared/strategy/types.ts'

function regime(overrides: Partial<RegimeResult> = {}): RegimeResult {
  return { regime: 'UP', dailyClose: 110, dailyMa: 100, barsUsed: 50, ...overrides }
}

// --- stopLossPctFor / takeProfitPctFor ------------------------------------

Deno.test('stopLossPctFor: the 2xATR floor binds at realistic volatility (real observed BTC atrPct)', () => {
  // Live-observed BTC atrPct = 1.10 (2026-09-19 decision record). 2x1.10% = 2.20%,
  // below the 2.5% floor -> the floor wins.
  assertAlmostEquals(stopLossPctFor(1.10), 0.025, 1e-9)
})

Deno.test('stopLossPctFor: 2xATR wins once volatility is high enough to clear the floor', () => {
  // atrPct=2.0 -> 2x2.0% = 4.0%, above the 2.5% floor.
  assertAlmostEquals(stopLossPctFor(2.0), 0.04, 1e-9)
})

Deno.test('stopLossPctFor: exactly at the floor boundary (atrPct=1.25 -> 2x=2.5%)', () => {
  assertAlmostEquals(stopLossPctFor(1.25), 0.025, 1e-9)
})

Deno.test('stopLossPctFor: unit conversion — atrPct is percentage-as-number (1.10 means 1.10%), not a fraction', () => {
  // A naive (unconverted) 2.0 * 1.10 = 2.20 would be a 220% stop — this
  // guards the exact /100 conversion in the implementation.
  const result = stopLossPctFor(1.10)
  assertEquals(result < 1, true) // must be a fraction, never >= 1 (100%)
  assertAlmostEquals(result, 0.025, 1e-9)
})

Deno.test('takeProfitPctFor: exactly 6x the stop distance', () => {
  assertAlmostEquals(takeProfitPctFor(0.025), 0.15, 1e-9)
  assertAlmostEquals(takeProfitPctFor(0.04), 0.24, 1e-9)
})

// --- buildCandidateProposal: FLAT -----------------------------------------

Deno.test('buildCandidateProposal: FLAT + UP regime -> OPEN_LONG, schema-valid', () => {
  const proposal = buildCandidateProposal({
    asset: 'BTC',
    currentState: 'FLAT',
    regime: regime({ regime: 'UP', dailyClose: 110, dailyMa: 100 }),
    atrPct: 1.10,
  })
  assertEquals(proposal.action, 'OPEN_LONG')
  if (proposal.action !== 'OPEN_LONG') throw new Error('unreachable')
  assertAlmostEquals(proposal.stopLossPct, 0.025, 1e-9)
  assertAlmostEquals(proposal.takeProfitPct, 0.15, 1e-9)
  assertEquals(proposal.invalidation.length >= 1, true)
  assertEquals(proposal.reasons[0]!.type, 'TECHNICAL')
  // Must parse against the real .strict() schema — no stray fields.
  const parsed = ModelDecisionProposal.safeParse(proposal)
  assertEquals(parsed.success, true)
})

Deno.test('buildCandidateProposal: FLAT + DOWN regime -> HOLD, empty invalidation is fine (no open thesis)', () => {
  const proposal = buildCandidateProposal({
    asset: 'BTC',
    currentState: 'FLAT',
    regime: regime({ regime: 'DOWN', dailyClose: 90, dailyMa: 100 }),
    atrPct: 1.10,
  })
  assertEquals(proposal.action, 'HOLD')
  assertEquals(proposal.invalidation, [])
  assertEquals(ModelDecisionProposal.safeParse(proposal).success, true)
})

// --- buildCandidateProposal: LONG ------------------------------------------

Deno.test('buildCandidateProposal: LONG + UP regime -> HOLD, reaffirming the SAME stable invalidation text', () => {
  const p1 = buildCandidateProposal({
    asset: 'BTC', currentState: 'LONG', regime: regime({ regime: 'UP', dailyClose: 111, dailyMa: 100 }), atrPct: 1.10,
  })
  const p2 = buildCandidateProposal({
    asset: 'BTC', currentState: 'LONG', regime: regime({ regime: 'UP', dailyClose: 115, dailyMa: 101 }), atrPct: 1.30,
  })
  assertEquals(p1.action, 'HOLD')
  assertEquals(p2.action, 'HOLD')
  assertEquals(p1.invalidation.length, 1)
  // Same text both cycles even though price/MA moved — a structural fact,
  // not a per-cycle judgment call (rules.ts's own doc comment).
  assertEquals(p1.invalidation[0]!.text, p2.invalidation[0]!.text)
  assertEquals(ModelDecisionProposal.safeParse(p1).success, true)
})

Deno.test('buildCandidateProposal: LONG + DOWN regime -> CLOSE, schema-valid, empty invalidation', () => {
  const proposal = buildCandidateProposal({
    asset: 'ETH', currentState: 'LONG', regime: regime({ regime: 'DOWN', dailyClose: 95, dailyMa: 100 }), atrPct: 1.5,
  })
  assertEquals(proposal.action, 'CLOSE')
  assertEquals(proposal.invalidation, [])
  assertEquals(proposal.reasons.length >= 1, true)
  assertEquals(ModelDecisionProposal.safeParse(proposal).success, true)
})

// --- buildCandidateProposal: SHORT (defensive, not expected live) --------

Deno.test('buildCandidateProposal: a pre-existing SHORT is never touched — HOLD regardless of regime', () => {
  const up = buildCandidateProposal({ asset: 'BTC', currentState: 'SHORT', regime: regime({ regime: 'UP' }), atrPct: 1.1 })
  const down = buildCandidateProposal({ asset: 'BTC', currentState: 'SHORT', regime: regime({ regime: 'DOWN' }), atrPct: 1.1 })
  assertEquals(up.action, 'HOLD')
  assertEquals(down.action, 'HOLD')
  assertEquals(ModelDecisionProposal.safeParse(up).success, true)
})

// --- No OPEN_SHORT is ever proposed (spec §5, §11 acceptance criteria) ---

Deno.test('buildCandidateProposal: OPEN_SHORT is never returned, for any state/regime combination', () => {
  const states = ['FLAT', 'LONG', 'SHORT'] as const
  const regimes = ['UP', 'DOWN'] as const
  for (const currentState of states) {
    for (const r of regimes) {
      const proposal = buildCandidateProposal({ asset: 'BTC', currentState, regime: regime({ regime: r }), atrPct: 1.1 })
      assertEquals(proposal.action === 'OPEN_SHORT', false)
    }
  }
})

// --- vetoedHoldProposal ------------------------------------------------------

Deno.test('vetoedHoldProposal: HOLD, empty invalidation, schema-valid, rationale embedded in the reason text', () => {
  const proposal = vetoedHoldProposal('BTC', 'exchange hack reported, exogenous confound')
  assertEquals(proposal.action, 'HOLD')
  assertEquals(proposal.asset, 'BTC')
  assertEquals(proposal.invalidation, [])
  assertEquals(proposal.reasons.length, 1)
  assertEquals(proposal.reasons[0]!.type, 'TECHNICAL')
  assertEquals(proposal.reasons[0]!.text.includes('exchange hack reported, exogenous confound'), true)
  assertEquals(ModelDecisionProposal.safeParse(proposal).success, true)
})
