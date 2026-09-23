import { assertEquals } from 'jsr:@std/assert@1'
import { AgentDecision, ModelDecisionProposal, Reason } from '../../../../src/shared/decisions/types.ts'

const technicalReason = { type: 'TECHNICAL', text: 'Price broke above EMA20 and EMA50.' }
const newsReason = { type: 'NEWS', text: 'ETF inflow reporting is strongly positive.', newsId: '11111111-1111-1111-1111-111111111111' }

function openLong(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    asset: 'BTC',
    action: 'OPEN_LONG',
    confidence: 0.74,
    stopLossPct: 0.03,
    takeProfitPct: 0.1,
    horizonHours: 48,
    reasons: [newsReason, technicalReason],
    invalidation: [{ text: 'ETF inflow trend reverses.' }],
    ...overrides,
  }
}

// --- ModelDecisionProposal: discriminated union structural guarantees ---

Deno.test('ModelDecisionProposal: a valid OPEN_LONG with SL/TP parses and narrows correctly', () => {
  const result = ModelDecisionProposal.safeParse(openLong())
  assertEquals(result.success, true)
  if (result.success && result.data.action === 'OPEN_LONG') {
    // Real narrowing, not just a successful parse — stopLossPct is
    // accessible as a plain number here, no null-check needed, because
    // the discriminated union removed the possibility at the type level.
    assertEquals(typeof result.data.stopLossPct, 'number')
  }
})

Deno.test('ModelDecisionProposal: OPEN_LONG missing stopLossPct is rejected', () => {
  const { stopLossPct: _drop, ...withoutSl } = openLong()
  const result = ModelDecisionProposal.safeParse(withoutSl)
  assertEquals(result.success, false)
})

Deno.test('ModelDecisionProposal: OPEN_SHORT missing takeProfitPct is rejected', () => {
  const { takeProfitPct: _drop, ...withoutTp } = openLong({ action: 'OPEN_SHORT' })
  const result = ModelDecisionProposal.safeParse(withoutTp)
  assertEquals(result.success, false)
})

Deno.test('ModelDecisionProposal: HOLD carrying a stray stopLossPct is REJECTED, not silently stripped', () => {
  // This is the case .strict() exists for — under Zod's default "strip"
  // mode this would parse successfully with stopLossPct quietly dropped,
  // defeating the structural guarantee the discriminated union exists to
  // make.
  const result = ModelDecisionProposal.safeParse({
    asset: 'BTC',
    action: 'HOLD',
    confidence: 0.6,
    horizonHours: null,
    reasons: [technicalReason],
    invalidation: [],
    stopLossPct: 0.03,
  })
  assertEquals(result.success, false)
})

Deno.test('ModelDecisionProposal: CLOSE carrying a stray takeProfitPct is REJECTED', () => {
  const result = ModelDecisionProposal.safeParse({
    asset: 'ETH',
    action: 'CLOSE',
    confidence: 0.8,
    horizonHours: null,
    reasons: [technicalReason],
    invalidation: [],
    takeProfitPct: 0.1,
  })
  assertEquals(result.success, false)
})

Deno.test('ModelDecisionProposal: a valid HOLD with no SL/TP fields parses cleanly', () => {
  const result = ModelDecisionProposal.safeParse({
    asset: 'BTC',
    action: 'HOLD',
    confidence: 0.55,
    horizonHours: null,
    reasons: [technicalReason],
    invalidation: [],
  })
  assertEquals(result.success, true)
})

Deno.test('ModelDecisionProposal: a valid CLOSE with empty invalidation parses cleanly (CLOSE may have none)', () => {
  const result = ModelDecisionProposal.safeParse({
    asset: 'BTC',
    action: 'CLOSE',
    confidence: 0.7,
    horizonHours: null,
    reasons: [technicalReason],
    invalidation: [],
  })
  assertEquals(result.success, true)
})

Deno.test('ModelDecisionProposal: OPEN_LONG with empty invalidation is rejected (opens always need at least one)', () => {
  const result = ModelDecisionProposal.safeParse(openLong({ invalidation: [] }))
  assertEquals(result.success, false)
})

Deno.test('ModelDecisionProposal: OPEN_SHORT with empty invalidation is rejected', () => {
  const result = ModelDecisionProposal.safeParse(openLong({ action: 'OPEN_SHORT', invalidation: [] }))
  assertEquals(result.success, false)
})

Deno.test('ModelDecisionProposal: the old BUY/SELL vocabulary is rejected', () => {
  const result = ModelDecisionProposal.safeParse(openLong({ action: 'BUY' }))
  assertEquals(result.success, false)
})

Deno.test('ModelDecisionProposal: confidence outside [0,1] is rejected', () => {
  const result = ModelDecisionProposal.safeParse(openLong({ confidence: 1.5 }))
  assertEquals(result.success, false)
})

// --- Reason: discriminated union for NEWS vs TECHNICAL -------------------

Deno.test('Reason: a NEWS reason without a newsId is rejected', () => {
  const result = Reason.safeParse({ type: 'NEWS', text: 'Something happened.' })
  assertEquals(result.success, false)
})

Deno.test('Reason: a TECHNICAL reason carrying a stray newsId is rejected', () => {
  const result = Reason.safeParse({ type: 'TECHNICAL', text: 'RSI is overbought.', newsId: '11111111-1111-1111-1111-111111111111' })
  assertEquals(result.success, false)
})

Deno.test('Reason: valid NEWS and TECHNICAL reasons both parse cleanly', () => {
  assertEquals(Reason.safeParse(newsReason).success, true)
  assertEquals(Reason.safeParse(technicalReason).success, true)
})

// --- AgentDecision: the full persisted record, flat -----------------------

function validAgentDecision(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    runId: '22222222-2222-2222-2222-222222222222',
    portfolioId: '33333333-3333-3333-3333-333333333333',
    positionId: '44444444-4444-4444-4444-444444444444',
    asset: 'BTC',

    action: 'OPEN_LONG',
    confidence: 0.74,
    primaryDriver: 'BOTH',
    proposedStopLossPct: 0.03,
    proposedTakeProfitPct: 0.1,
    horizonHours: 48,
    reasons: [newsReason, technicalReason],
    invalidation: [{ text: 'ETF inflow trend reverses.' }],
    citedNewsIds: ['11111111-1111-1111-1111-111111111111'],

    riskStatus: 'approved',
    riskReason: null,
    approvedSizePct: 0.18,
    computedStopLossPrice: 74545.47,
    computedTakeProfitPrice: 84536.1,
    sizeCapApplied: null,

    effectiveMinConfidence: 0.65,
    effectiveRiskBudgetPct: 0.01,
    effectiveSingleTradeCapPct: 0.2,
    effectiveAssetExposureCapPct: 0.35,
    effectivePortfolioRiskCeilingPct: 0.0075,
    effectiveMaxTotalNotionalPct: 0.3,

    inputPayload: { note: 'arbitrary shape at this layer, deliberately' },
    outputPayload: { note: 'arbitrary shape at this layer, deliberately' },
    promptVersion: 'v1',
    modelVersion: 'gemini-2.5-flash',
    strategyVersion: 'v1-regime',
    modelVetoed: false,

    // Phase 2 (2026-09-22) provenance — null throughout for this fixture:
    // it represents a pre-Phase-2-shaped OPEN_LONG decision, which never
    // asked a management question.
    proposedAction: null,
    proposedActionConfidence: null,
    proposedAdjustNotional: null,
    executedAdjustNotional: null,
    stopLossPriceBefore: null,
    stopLossPriceAfter: null,
    takeProfitPriceBefore: null,
    takeProfitPriceAfter: null,
    protectionRejectionReason: null,

    decidedAt: '2026-09-18T12:00:00.000Z',
    ...overrides,
  }
}

Deno.test('AgentDecision: a fully-populated approved OPEN_LONG record parses cleanly', () => {
  const result = AgentDecision.safeParse(validAgentDecision())
  assertEquals(result.success, true)
})

Deno.test('AgentDecision: a HOLD record with every open-only field null parses cleanly (not_applicable risk status)', () => {
  const result = AgentDecision.safeParse(validAgentDecision({
    action: 'HOLD',
    positionId: null,
    proposedStopLossPct: null,
    proposedTakeProfitPct: null,
    citedNewsIds: [],
    riskStatus: 'not_applicable',
    riskReason: null,
    approvedSizePct: null,
    computedStopLossPrice: null,
    computedTakeProfitPrice: null,
    sizeCapApplied: null,
  }))
  assertEquals(result.success, true)
})

Deno.test('AgentDecision: a rejected proposal must still carry every effective_* config value (denormalized on every row)', () => {
  const result = AgentDecision.safeParse(validAgentDecision({
    riskStatus: 'rejected',
    riskReason: 'confidence 0.5 below effective minimum 0.65',
    approvedSizePct: null,
    computedStopLossPrice: null,
    computedTakeProfitPrice: null,
  }))
  assertEquals(result.success, true)
})

Deno.test('AgentDecision: an invalid risk_status value is rejected', () => {
  const result = AgentDecision.safeParse(validAgentDecision({ riskStatus: 'maybe' }))
  assertEquals(result.success, false)
})

Deno.test('AgentDecision: an invalid primary_driver value is rejected', () => {
  const result = AgentDecision.safeParse(validAgentDecision({ primaryDriver: 'VIBES' }))
  assertEquals(result.success, false)
})
