import { assertEquals, assertStrictEquals } from 'jsr:@std/assert@1'
import { applyVetoOutcome } from './apply-veto.ts'
import { evaluateRiskGate } from '../../../../src/shared/risk/gate.ts'
import type { RiskGateContext } from '../../../../src/shared/risk/gate.ts'
import type { ModelDecisionProposal } from '../../../../src/shared/decisions/types.ts'
import type { VetoOutcome } from '../model/jev/provider.ts'

// ⭐ This file is the unit half of the single most important regression
// test in the Gemini -> Jev migration (the user's explicit revision #4):
// Jev can only ever REMOVE a candidate, never make an otherwise-invalid
// one tradable, and an ALLOW must never alter the candidate in any way
// before it reaches the risk gate. The live half runs in Phase 3 against
// the first real cycle (see the migration plan's "Exact validation
// sequence" item 4).

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
    nowIso: '2026-09-22T12:00:00.000Z',
    portfolioRiskCeilingUsd: 10_000,
    otherOpenPositionsRiskAtStopUsd: 0,
    maxTotalNotionalUsd: 10_000,
    otherSameDirectionNotionalUsd: 0,
    peakNav: 10_000,
    drawdownBreakerFloorPct: 0.90,
    openPosition: null,
    feeBps: 10,
    slippageBps: 5,
    minTradeNotionalPct: 0.01,
    minTradeNotionalUsd: 25,
    ...overrides,
  }
}

function openLongCandidate(overrides: Partial<ModelDecisionProposal> = {}): ModelDecisionProposal {
  return {
    asset: 'BTC',
    action: 'OPEN_LONG',
    confidence: 1,
    stopLossPct: 0.03,
    takeProfitPct: 0.18,
    horizonHours: null,
    reasons: [{ type: 'TECHNICAL', text: 'Daily close above the 50-day MA' }],
    invalidation: [{ text: 'Daily close at or below the 50-day moving average' }],
    ...overrides,
  } as ModelDecisionProposal
}

function allow(): VetoOutcome {
  return { asset: 'BTC', veto: false, noul: 0.12 }
}

function veto(): VetoOutcome {
  return { asset: 'BTC', veto: true, noul: 0.91 }
}

// --- Structural: ALLOW is a strict pass-through -------------------------

Deno.test('applyVetoOutcome: ALLOW returns the exact same candidate object by reference — not a copy, not a re-derivation', () => {
  const candidate = openLongCandidate()
  const result = applyVetoOutcome(candidate, 'BTC', allow(), 2)
  assertStrictEquals(result, candidate)
})

Deno.test('applyVetoOutcome: ALLOW leaves every field — action, sizing, SL/TP, reasons, invalidation — untouched', () => {
  const candidate = openLongCandidate({ stopLossPct: 0.041, takeProfitPct: 0.246, confidence: 1 })
  const result = applyVetoOutcome(candidate, 'BTC', allow(), 5)
  assertEquals(result, candidate)
  assertEquals(result.action, 'OPEN_LONG')
  assertEquals((result as { stopLossPct: number }).stopLossPct, 0.041)
  assertEquals((result as { takeProfitPct: number }).takeProfitPct, 0.246)
})

Deno.test('applyVetoOutcome: VETO replaces the candidate with a deterministic HOLD, never the original OPEN_LONG', () => {
  const candidate = openLongCandidate()
  const result = applyVetoOutcome(candidate, 'BTC', veto(), 3)
  assertEquals(result.action, 'HOLD')
  assertEquals(result === candidate, false)
})

Deno.test('applyVetoOutcome: the VETO rationale is a deterministic audit string — noul, threshold, and news count only, no model-authored prose', () => {
  const result = applyVetoOutcome(openLongCandidate(), 'BTC', { asset: 'BTC', veto: true, noul: 0.873 }, 3)
  assertEquals(result.reasons[0]!.text, 'Vetoed: noul=0.87, threshold=0.70, 3 news items evaluated')
})

Deno.test('applyVetoOutcome: singular/plural news-count wording', () => {
  const one = applyVetoOutcome(openLongCandidate(), 'BTC', veto(), 1)
  assertEquals(one.reasons[0]!.text.includes('1 news item evaluated'), true)
  const zero = applyVetoOutcome(openLongCandidate(), 'BTC', veto(), 0)
  assertEquals(zero.reasons[0]!.text.includes('0 news items evaluated'), true)
})

// --- End-to-end through the real, unchanged risk gate --------------------

Deno.test('applyVetoOutcome + evaluateRiskGate: ALLOW reaches the gate unmodified, and the gate approves it purely on its own deterministic logic', () => {
  const candidate = openLongCandidate()
  const proposal = applyVetoOutcome(candidate, 'BTC', allow(), 2)
  assertStrictEquals(proposal, candidate)
  const result = evaluateRiskGate(proposal, baseContext())
  assertEquals(result.riskStatus === 'rejected', false, 'a plain, gate-eligible candidate must be approved when Jev allows it')
  assertEquals(result.approvedSizePct !== null, true)
})

Deno.test('applyVetoOutcome + evaluateRiskGate: NEGATIVE CONTROL — a gate-rejectable candidate stays rejected under ALLOW; ALLOW is not a permission slip', () => {
  // Drawdown breaker active: peakNav 10_000, floor 0.90 -> floor NAV 9000,
  // current nav 8000 is below it (same fixture as gate.test.ts's own
  // drawdown-breaker case) — this candidate would be rejected by the gate
  // regardless of what any model says about it.
  const candidate = openLongCandidate()
  const proposal = applyVetoOutcome(candidate, 'BTC', allow(), 0)
  assertStrictEquals(proposal, candidate, 'ALLOW must still be a pure pass-through even when the candidate is headed for rejection')
  const result = evaluateRiskGate(proposal, baseContext({ nav: 8000, peakNav: 10_000, drawdownBreakerFloorPct: 0.90 }))
  assertEquals(result.riskStatus, 'rejected', 'an ALLOW from Jev must never override a deterministic gate rejection')
})

Deno.test('applyVetoOutcome + evaluateRiskGate: VETO removes an otherwise-approvable candidate — the one thing Jev is allowed to do', () => {
  const candidate = openLongCandidate()
  const proposal = applyVetoOutcome(candidate, 'BTC', veto(), 2)
  const result = evaluateRiskGate(proposal, baseContext())
  assertEquals(result.riskStatus, 'not_applicable', 'a vetoed candidate becomes a HOLD, which the gate treats as not_applicable, not an open')
  assertEquals(proposal.action, 'HOLD')
})
