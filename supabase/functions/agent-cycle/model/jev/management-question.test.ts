import { assertEquals } from 'jsr:@std/assert@1'
import {
  ADD_MAGNITUDE_BY_SCORE_LEVEL,
  addConvictionQuestionId,
  buildManagementQuestions,
  buildPortfolioState,
  magnitudeFromScore,
  managementActionQuestionId,
  MANAGEMENT_QUESTION_VERSION,
  reduceMagnitudeQuestionId,
  REDUCE_MAGNITUDE_BY_SCORE_LEVEL,
  stopIntentQuestionId,
  targetIntentQuestionId,
  TP_STEP_ATR_MULTIPLE,
} from './management-question.ts'
import type { ManagementCandidateInput } from './management-question.ts'
import type { VetoCandidateInput } from '../payload.ts'

function managementCandidate(overrides: Partial<ManagementCandidateInput> = {}): ManagementCandidateInput {
  return {
    asset: 'BTC',
    direction: 'long',
    entryPrice: 100,
    currentPrice: 120,
    quantity: 10,
    stopLossPrice: 90,
    takeProfitPrice: 180,
    heldHours: 12,
    feeBps: 10,
    slippageBps: 5,
    atrPct: 2.5,
    news: [],
    ...overrides,
  }
}

function vetoCandidate(overrides: Partial<VetoCandidateInput> = {}): VetoCandidateInput {
  return {
    asset: 'ETH',
    news: [{ id: 'news-1', source: 'Cointelegraph', headline: 'Test', summary: null, publishedAt: '2026-09-22T08:00:00.000Z', ageMinutes: 60 }],
    ...overrides,
  }
}

// --- magnitudeFromScore ------------------------------------------------

Deno.test('magnitudeFromScore: rounds to the nearest level and maps to its fraction', () => {
  assertEquals(magnitudeFromScore(0, ADD_MAGNITUDE_BY_SCORE_LEVEL), 0.25)
  assertEquals(magnitudeFromScore(0.4, ADD_MAGNITUDE_BY_SCORE_LEVEL), 0.25) // rounds to 0
  assertEquals(magnitudeFromScore(0.6, ADD_MAGNITUDE_BY_SCORE_LEVEL), 0.50) // rounds to 1
  assertEquals(magnitudeFromScore(1, ADD_MAGNITUDE_BY_SCORE_LEVEL), 0.50)
  assertEquals(magnitudeFromScore(2, ADD_MAGNITUDE_BY_SCORE_LEVEL), 1.00)
})

Deno.test('magnitudeFromScore: clamps out-of-range scores rather than throwing or indexing out of bounds', () => {
  assertEquals(magnitudeFromScore(-1, ADD_MAGNITUDE_BY_SCORE_LEVEL), 0.25)
  assertEquals(magnitudeFromScore(99, ADD_MAGNITUDE_BY_SCORE_LEVEL), 1.00)
})

Deno.test('magnitudeFromScore: REDUCE levels never reach 1.00 — a full reduce is a CLOSE, not a REDUCE', () => {
  assertEquals(magnitudeFromScore(2, REDUCE_MAGNITUDE_BY_SCORE_LEVEL), 0.75)
  assertEquals(Math.max(...REDUCE_MAGNITUDE_BY_SCORE_LEVEL) < 1, true)
})

// --- buildPortfolioState ------------------------------------------------

Deno.test('buildPortfolioState: a pure veto-only cycle (no management candidates) keeps the narrow pre-Phase-2 shape — no portfolio-level fields', () => {
  const state = buildPortfolioState([vetoCandidate()], [], 10_000, 8_000, 0.3, '2026-09-22T12:00:00.000Z')
  assertEquals('navUsd' in state, false)
  assertEquals('availableCashUsd' in state, false)
  assertEquals(Object.keys(state.assets), ['ETH'])
})

Deno.test('buildPortfolioState: an OPEN position adds portfolio-level fields and a position snapshot, never touching the veto asset', () => {
  const state = buildPortfolioState([vetoCandidate({ asset: 'ETH' })], [managementCandidate({ asset: 'BTC' })], 10_000, 8_000, 0.3, '2026-09-22T12:00:00.000Z')
  assertEquals(state.navUsd, 10_000)
  assertEquals(state.availableCashUsd, 8_000)
  assertEquals(state.totalExposurePct, 0.3)
  assertEquals(Object.keys(state.assets).sort(), ['BTC', 'ETH'])
  assertEquals(state.assets.ETH!.position, undefined)
  assertEquals(state.assets.BTC!.position !== undefined, true)
})

Deno.test('buildPortfolioState: position snapshot computes unrealizedPnlPct/Usd, notional, and distances correctly (long)', () => {
  const state = buildPortfolioState([], [managementCandidate({ asset: 'BTC', entryPrice: 100, currentPrice: 120, quantity: 10, stopLossPrice: 90, takeProfitPrice: 180 })], 10_000, 8_000, 0.3, '2026-09-22T12:00:00.000Z')
  const position = state.assets.BTC!.position!
  assertEquals(position.notionalUsd, 1200) // 10 * 120
  assertEquals(position.unrealizedPnlPct, 0.2) // (120-100)/100
  assertEquals(position.unrealizedPnlUsd, 200) // (120-100)*10
  assertEquals(position.distanceToStopPct, (120 - 90) / 120)
  assertEquals(position.distanceToTakeProfitPct, (180 - 120) / 120)
})

Deno.test('buildPortfolioState: estimatedRoundTripCostPct is 2x(fee+slippage) as a fraction', () => {
  const state = buildPortfolioState([], [managementCandidate({ feeBps: 10, slippageBps: 5 })], 10_000, 8_000, 0.3, '2026-09-22T12:00:00.000Z')
  const position = state.assets.BTC!.position!
  assertEquals(position.estimatedRoundTripCostPct, (2 * (10 + 5)) / 10_000)
})

Deno.test('buildPortfolioState: never carries feeBps/slippageBps themselves, portfolio ids, or user identifiers — only the derived state fields', () => {
  const state = buildPortfolioState([], [managementCandidate()], 10_000, 8_000, 0.3, '2026-09-22T12:00:00.000Z')
  const serialized = JSON.stringify(state)
  assertEquals(serialized.includes('feeBps'), false)
  assertEquals(serialized.includes('slippageBps'), false)
  assertEquals(serialized.includes('portfolioId'), false)
})

// --- buildManagementQuestions --------------------------------------------

Deno.test('buildManagementQuestions: exactly 5 questions per candidate, correctly keyed', () => {
  const questions = buildManagementQuestions([managementCandidate({ asset: 'BTC' })])
  assertEquals(Object.keys(questions).sort(), [
    'btc_action', 'btc_add_conviction', 'btc_reduce_magnitude', 'btc_stop_intent', 'btc_target_intent',
  ])
})

Deno.test('buildManagementQuestions: the action question is a Choice with all 5 action criteria', () => {
  const questions = buildManagementQuestions([managementCandidate({ asset: 'BTC' })])
  const action = questions[managementActionQuestionId('BTC')]!
  assertEquals(action.type, 'choice')
  assertEquals(Object.keys(action.criteria).sort(), ['ADD', 'CLOSE', 'HOLD', 'MODIFY_PROTECTION', 'REDUCE'])
})

Deno.test('buildManagementQuestions: add_conviction and reduce_magnitude are Score questions with 3 levels each', () => {
  const questions = buildManagementQuestions([managementCandidate({ asset: 'BTC' })])
  const add = questions[addConvictionQuestionId('BTC')]!
  const reduce = questions[reduceMagnitudeQuestionId('BTC')]!
  assertEquals(add.type, 'score')
  assertEquals(reduce.type, 'score')
  if (add.type === 'score') assertEquals(add.criteria.length, 3)
  if (reduce.type === 'score') assertEquals(reduce.criteria.length, 3)
})

Deno.test('buildManagementQuestions: stop_intent and target_intent are Choice questions with the exact expected option sets', () => {
  const questions = buildManagementQuestions([managementCandidate({ asset: 'BTC' })])
  const stop = questions[stopIntentQuestionId('BTC')]!
  const target = questions[targetIntentQuestionId('BTC')]!
  assertEquals(stop.type, 'choice')
  assertEquals(target.type, 'choice')
  if (stop.type === 'choice') assertEquals(Object.keys(stop.criteria).sort(), ['KEEP', 'TIGHTEN_TO_BREAKEVEN'])
  if (target.type === 'choice') assertEquals(Object.keys(target.criteria).sort(), ['KEEP', 'MOVE_CLOSER', 'MOVE_OUT'])
})

Deno.test('buildManagementQuestions: zero candidates produces zero questions', () => {
  assertEquals(buildManagementQuestions([]), {})
})

Deno.test('buildManagementQuestions: two candidates produce 10 questions total, none cross-contaminated', () => {
  const questions = buildManagementQuestions([managementCandidate({ asset: 'BTC' }), managementCandidate({ asset: 'ETH' })])
  assertEquals(Object.keys(questions).length, 10)
  assertEquals(questions[managementActionQuestionId('BTC')]!.instructions.includes('BTC'), true)
  assertEquals(questions[managementActionQuestionId('ETH')]!.instructions.includes('ETH'), true)
})

// --- version constant -----------------------------------------------------

Deno.test('MANAGEMENT_QUESTION_VERSION encodes the ATR step multiple, so a later change is visible in persisted provenance', () => {
  assertEquals(MANAGEMENT_QUESTION_VERSION, `jev-management-v1/atr${TP_STEP_ATR_MULTIPLE.toFixed(1)}`)
  assertEquals(TP_STEP_ATR_MULTIPLE, 1.0)
})
