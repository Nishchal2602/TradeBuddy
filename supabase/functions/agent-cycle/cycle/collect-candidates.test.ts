import { assertEquals } from 'jsr:@std/assert@1'
import { collectModelCandidates, shouldCallModel } from './collect-candidates.ts'
import type { CandidateFlags, CandidateSource } from './collect-candidates.ts'
import type { ModelDecisionProposal } from '../../../../src/shared/decisions/types.ts'
import type { Position } from '../../../../src/shared/positions/types.ts'

const NOW = '2026-09-23T12:00:00.000Z'

const BOTH_ENABLED: CandidateFlags = { newsVetoEnabled: true, managementEnabled: true, feeBps: 10, slippageBps: 5 }

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

// The "thesis intact" HOLD — trading-strategy-v1.md's own text for an
// open LONG whose regime hasn't flipped. Deliberately the same shape a
// FLAT+DOWN "no eligibility" HOLD would have on this type — the
// DIFFERENCE that routes one to management and the other to neither list
// is openPosition, not anything on the proposal itself.
function intactThesisHold(overrides: Partial<ModelDecisionProposal> = {}): ModelDecisionProposal {
  return {
    asset: 'BTC',
    action: 'HOLD',
    confidence: 1,
    horizonHours: null,
    reasons: [{ type: 'TECHNICAL', text: 'Daily close still above the 50-day MA — regime unchanged' }],
    invalidation: [{ text: 'Daily close at or below the 50-day moving average' }],
    ...overrides,
  } as ModelDecisionProposal
}

function noEligibilityHold(overrides: Partial<ModelDecisionProposal> = {}): ModelDecisionProposal {
  return {
    asset: 'BTC',
    action: 'HOLD',
    confidence: 1,
    horizonHours: null,
    reasons: [{ type: 'TECHNICAL', text: 'Daily close at or below the 50-day MA — no long eligibility' }],
    invalidation: [],
    ...overrides,
  } as ModelDecisionProposal
}

function openPosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'pos-1',
    portfolioId: 'portfolio-1',
    asset: 'BTC',
    direction: 'long',
    quantity: 0.5,
    entryPrice: 80000,
    costBasis: 40000,
    stopLossPrice: 76000,
    takeProfitPrice: 100000,
    status: 'open',
    openedAt: '2026-09-21T12:00:00.000Z', // 48h before NOW
    closedAt: null,
    realizedPnl: null,
    closeReason: null,
    openedByDecisionId: null,
    closedByDecisionId: null,
    ...overrides,
  } as Position
}

function source(overrides: Partial<CandidateSource> = {}): CandidateSource {
  return {
    asset: 'BTC',
    candidate: noEligibilityHold(),
    openPosition: null,
    news: [],
    currentPrice: 85000,
    atrPct: 1.2,
    ...overrides,
  }
}

// --- Test 1/2: an OPEN position with an intact thesis still gets collected

Deno.test('collectModelCandidates: OPEN BTC + intact thesis (HOLD) -> exactly one management candidate, zero veto candidates', () => {
  const { vetoCandidates, managementCandidates } = collectModelCandidates(
    [source({ asset: 'BTC', candidate: intactThesisHold(), openPosition: openPosition() })],
    BOTH_ENABLED,
    NOW,
  )
  assertEquals(vetoCandidates.length, 0)
  assertEquals(managementCandidates.length, 1)
  assertEquals(managementCandidates[0]!.asset, 'BTC')
  assertEquals(managementCandidates[0]!.direction, 'long')
  assertEquals(managementCandidates[0]!.quantity, 0.5)
  assertEquals(managementCandidates[0]!.heldHours, 48)
})

Deno.test('collectModelCandidates: OPEN ETH + intact thesis (HOLD) -> exactly one management candidate, zero veto candidates', () => {
  const { vetoCandidates, managementCandidates } = collectModelCandidates(
    [source({ asset: 'ETH', candidate: intactThesisHold({ asset: 'ETH' }), openPosition: openPosition({ asset: 'ETH', direction: 'long' }) })],
    BOTH_ENABLED,
    NOW,
  )
  assertEquals(vetoCandidates.length, 0)
  assertEquals(managementCandidates.length, 1)
  assertEquals(managementCandidates[0]!.asset, 'ETH')
})

Deno.test('collectModelCandidates: BTC and ETH both open with intact theses in one cycle -> both collected into one batch', () => {
  const { vetoCandidates, managementCandidates } = collectModelCandidates(
    [
      source({ asset: 'BTC', candidate: intactThesisHold(), openPosition: openPosition({ asset: 'BTC' }) }),
      source({ asset: 'ETH', candidate: intactThesisHold({ asset: 'ETH' }), openPosition: openPosition({ asset: 'ETH' }) }),
    ],
    BOTH_ENABLED,
    NOW,
  )
  assertEquals(vetoCandidates.length, 0)
  assertEquals(managementCandidates.length, 2)
  assertEquals(managementCandidates.map((c) => c.asset).sort(), ['BTC', 'ETH'])
})

Deno.test('collectModelCandidates: this is the fix — an open position with an INTACT bullish thesis is not skipped by any regime/action shortcut', () => {
  // Directly exercises the reported symptom's shape: regime UP (daily
  // close above the 50DMA), candidate HOLD, position OPEN. Must still
  // produce a management candidate, proving the thesis being intact
  // (rather than flipped) is what routes here, not a reason to skip it.
  const { managementCandidates } = collectModelCandidates(
    [source({ candidate: intactThesisHold(), openPosition: openPosition() })],
    BOTH_ENABLED,
    NOW,
  )
  assertEquals(managementCandidates.length, 1, 'an intact thesis must not prevent management evaluation')
})

// --- Test 3: FLAT + no entry candidate -> nothing collected, no call

Deno.test('collectModelCandidates: FLAT + no entry eligibility -> both lists empty', () => {
  const { vetoCandidates, managementCandidates } = collectModelCandidates(
    [source({ candidate: noEligibilityHold(), openPosition: null })],
    BOTH_ENABLED,
    NOW,
  )
  assertEquals(vetoCandidates.length, 0)
  assertEquals(managementCandidates.length, 0)
})

Deno.test('shouldCallModel: FLAT + no entry eligibility -> no call (the zero-candidate path actually proven, not just collection)', () => {
  const { vetoCandidates, managementCandidates } = collectModelCandidates(
    [source({ candidate: noEligibilityHold(), openPosition: null })],
    BOTH_ENABLED,
    NOW,
  )
  assertEquals(shouldCallModel(vetoCandidates, managementCandidates, null), false)
})

// --- Test 5: FLAT -> candidate -> veto path is unchanged (behavioural only)

Deno.test('collectModelCandidates: FLAT + OPEN_LONG candidate -> exactly one veto candidate, zero management candidates', () => {
  const { vetoCandidates, managementCandidates } = collectModelCandidates(
    [source({ candidate: openLongCandidate(), openPosition: null })],
    BOTH_ENABLED,
    NOW,
  )
  assertEquals(vetoCandidates.length, 1)
  assertEquals(vetoCandidates[0]!.asset, 'BTC')
  assertEquals(managementCandidates.length, 0)
})

Deno.test('shouldCallModel: FLAT + OPEN_LONG candidate -> a call happens', () => {
  const { vetoCandidates, managementCandidates } = collectModelCandidates(
    [source({ candidate: openLongCandidate(), openPosition: null })],
    BOTH_ENABLED,
    NOW,
  )
  assertEquals(shouldCallModel(vetoCandidates, managementCandidates, null), true)
})

// --- CLOSE (regime flip) never reaches either list — Jev cannot override it

Deno.test('collectModelCandidates: an OPEN position whose regime has flipped (CLOSE) never reaches management — the thesis-invalidation rule is not Jev-overridable', () => {
  const closeCandidate: ModelDecisionProposal = {
    asset: 'BTC',
    action: 'CLOSE',
    confidence: 1,
    horizonHours: null,
    reasons: [{ type: 'TECHNICAL', text: 'Daily close at or below the 50-day MA — regime flip, thesis invalidated' }],
    invalidation: [],
  }
  const { vetoCandidates, managementCandidates } = collectModelCandidates(
    [source({ candidate: closeCandidate, openPosition: openPosition() })],
    BOTH_ENABLED,
    NOW,
  )
  assertEquals(vetoCandidates.length, 0)
  assertEquals(managementCandidates.length, 0)
})

// --- shouldCallModel: the full truth table, every row its own test -------

Deno.test('shouldCallModel: 0 veto, 0 management, no failure -> No', () => {
  assertEquals(shouldCallModel([], [], null), false)
})

Deno.test('shouldCallModel: >=1 veto, 0 management, no failure -> Yes', () => {
  assertEquals(shouldCallModel([{ asset: 'BTC', news: [] }], [], null), true)
})

Deno.test('shouldCallModel: 0 veto, >=1 management, no failure -> Yes', () => {
  const mgmt = collectModelCandidates([source({ candidate: intactThesisHold(), openPosition: openPosition() })], BOTH_ENABLED, NOW).managementCandidates
  assertEquals(shouldCallModel([], mgmt, null), true)
})

Deno.test('shouldCallModel: >=1 veto, >=1 management, no failure -> Yes', () => {
  const mgmt = collectModelCandidates([source({ candidate: intactThesisHold(), openPosition: openPosition() })], BOTH_ENABLED, NOW).managementCandidates
  assertEquals(shouldCallModel([{ asset: 'BTC', news: [] }], mgmt, null), true)
})

Deno.test('shouldCallModel: any candidates, but a failure reason is set -> No, regardless of what was collected', () => {
  const mgmt = collectModelCandidates([source({ candidate: intactThesisHold(), openPosition: openPosition() })], BOTH_ENABLED, NOW).managementCandidates
  assertEquals(shouldCallModel([{ asset: 'BTC', news: [] }], mgmt, 'news retrieval failed'), false)
  assertEquals(shouldCallModel([], [], 'news retrieval failed'), false)
})

// --- Independent flags: THIS is the direct regression test for the defect

Deno.test('collectModelCandidates: management_enabled=false collects zero management candidates while veto still collects — the two layers do not share a switch', () => {
  const flags: CandidateFlags = { ...BOTH_ENABLED, managementEnabled: false }
  const { vetoCandidates, managementCandidates } = collectModelCandidates(
    [
      source({ asset: 'BTC', candidate: openLongCandidate(), openPosition: null }),
      source({ asset: 'ETH', candidate: intactThesisHold({ asset: 'ETH' }), openPosition: openPosition({ asset: 'ETH' }) }),
    ],
    flags,
    NOW,
  )
  assertEquals(vetoCandidates.length, 1, 'veto must be unaffected by management_enabled')
  assertEquals(managementCandidates.length, 0, 'management must be fully disabled by its own flag')
})

Deno.test('collectModelCandidates: news_veto_enabled=false collects zero veto candidates while management still collects — this is the actual defect Phase 2.1 fixes (management used to be silently gated by this same flag)', () => {
  const flags: CandidateFlags = { ...BOTH_ENABLED, newsVetoEnabled: false }
  const { vetoCandidates, managementCandidates } = collectModelCandidates(
    [
      source({ asset: 'BTC', candidate: openLongCandidate(), openPosition: null }),
      source({ asset: 'ETH', candidate: intactThesisHold({ asset: 'ETH' }), openPosition: openPosition({ asset: 'ETH' }) }),
    ],
    flags,
    NOW,
  )
  assertEquals(vetoCandidates.length, 0, 'veto must be fully disabled by its own flag')
  assertEquals(managementCandidates.length, 1, 'management must be unaffected by news_veto_enabled — the exact coupling this fix removes')
})

Deno.test('collectModelCandidates + shouldCallModel: both flags off -> nothing collected, no call', () => {
  const flags: CandidateFlags = { newsVetoEnabled: false, managementEnabled: false, feeBps: 10, slippageBps: 5 }
  const { vetoCandidates, managementCandidates } = collectModelCandidates(
    [
      source({ asset: 'BTC', candidate: openLongCandidate(), openPosition: null }),
      source({ asset: 'ETH', candidate: intactThesisHold({ asset: 'ETH' }), openPosition: openPosition({ asset: 'ETH' }) }),
    ],
    flags,
    NOW,
  )
  assertEquals(vetoCandidates.length, 0)
  assertEquals(managementCandidates.length, 0)
  assertEquals(shouldCallModel(vetoCandidates, managementCandidates, null), false)
})
