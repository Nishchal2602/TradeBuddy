import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import {
  ADD_MAGNITUDE_BY_SCORE_LEVEL,
  addConvictionQuestionId,
  buildManagementQuestions,
  buildPortfolioState,
  isProtectionActionable,
  magnitudeFromScore,
  managementActionQuestionId,
  MANAGEMENT_QUESTION_VERSION,
  reduceMagnitudeQuestionId,
  REDUCE_MAGNITUDE_BY_SCORE_LEVEL,
  remainingUpsideQuestionId,
  stopIntentQuestionId,
  targetIntentQuestionId,
  TP_STEP_ATR_MULTIPLE,
} from './management-question.ts'
import type { AggressiveManagementContext, ManagementCandidateInput } from './management-question.ts'
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
    minStopLossPct: 0.005,
    ...overrides,
  }
}

function aggressiveContext(overrides: Partial<AggressiveManagementContext> = {}): AggressiveManagementContext {
  return {
    initialEntryPrice: 100,
    initialStopLossPrice: 92, // riskPerUnit0 = 8, initialRiskUsd = 8*10 = 80 at qty 10
    initialRiskUsd: 80,
    partialRealizedPnlUsd: 0,
    sampledMfeR: 2.0,
    sampledMaeR: -0.2,
    minutesSinceEntry: 45,
    currentRoundTripCostUsd: 3,
    ret15mPct: 0.2,
    ret30mPct: 0.4,
    ret60mPct: 0.6,
    realizedVol5m: 0.05,
    volumeTrendRatio: 1.2,
    sampledDayHighPct: -1.5,
    sampledDayLowPct: 3.0,
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
  if (stop.type === 'choice') assertEquals(Object.keys(stop.criteria).sort(), ['KEEP', 'TIGHTEN_TOWARD_ENTRY'])
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
  assertEquals(MANAGEMENT_QUESTION_VERSION, `jev-management-v2/atr${TP_STEP_ATR_MULTIPLE.toFixed(1)}`)
  assertEquals(TP_STEP_ATR_MULTIPLE, 1.0)
})

// --- Aggressive V3.1 profit recycling: buildPositionSnapshot ---------------
// (migration plan §4.1) ------------------------------------------------------

Deno.test("Balanced's snapshot is BYTE-IDENTICAL to before this revision — no extension keys at all when candidate.aggressive is absent", () => {
  const state = buildPortfolioState([], [managementCandidate()], 10_000, 8_000, 0.3, '2026-09-22T12:00:00.000Z')
  const position = state.assets.BTC!.position!
  assertEquals(Object.keys(position).sort(), [
    'currentPrice', 'direction', 'distanceToStopPct', 'distanceToTakeProfitPct', 'entryPrice',
    'estimatedRoundTripCostPct', 'heldHours', 'notionalUsd', 'quantity', 'stopLossPrice',
    'takeProfitPrice', 'unrealizedPnlPct', 'unrealizedPnlUsd',
  ])
})

Deno.test('Aggressive snapshot: positionPnlR/priceR/sampledMfeR are wired through correctly (no ADD, so the two R metrics coincide)', () => {
  const state = buildPortfolioState([], [managementCandidate({ aggressive: aggressiveContext() })], 10_000, 8_000, 0.3, '2026-09-22T12:00:00.000Z')
  const position = state.assets.BTC!.position!
  // unrealizedPnlUsd = (120-100)*10 = 200; positionPnlR = 200/80 = 2.5
  assertAlmostEquals(position.positionPnlR!, 2.5, 1e-9)
  // priceR = (120-100)/|100-92| = 2.5 — coincides with positionPnlR here
  // ONLY because no ADD has occurred (quantity is unchanged from origination).
  assertAlmostEquals(position.priceR!, 2.5, 1e-9)
  assertAlmostEquals(position.sampledMfeR!, 2.0, 1e-9)
  assertAlmostEquals(position.costR!, 3 / 80, 1e-9)
  assertEquals(position.atrPct, 2.5) // the SAME figure managementAtrPctFor computed, not re-derived
  assertAlmostEquals(position.ret15mPct!, 0.2, 1e-9)
})

Deno.test('Aggressive snapshot: profitState and givebackR/Ratio track how much of the best gain has been given back', () => {
  // positionPnlR now 1.25 (currentPrice 110), sampledMfeR still 2.0 -> giveback 0.75 / 2.0 = 0.375 -> DETERIORATING
  const state = buildPortfolioState([], [managementCandidate({ currentPrice: 110, aggressive: aggressiveContext() })], 10_000, 8_000, 0.3, '2026-09-22T12:00:00.000Z')
  const position = state.assets.BTC!.position!
  assertAlmostEquals(position.positionPnlR!, 1.25, 1e-9)
  assertAlmostEquals(position.givebackR!, 0.75, 1e-9)
  assertAlmostEquals(position.givebackRatio!, 0.375, 1e-9)
  assertEquals(position.profitState, 'DETERIORATING')
})

Deno.test('Aggressive snapshot: profitState is UNPROVEN below +1R MFE, PROVEN with little giveback, GIVING_BACK with most of it gone', () => {
  const unproven = buildPortfolioState([], [managementCandidate({ aggressive: aggressiveContext({ sampledMfeR: 0.5 }) })], 10_000, 8_000, 0.3, '2026-09-22T12:00:00.000Z')
  assertEquals(unproven.assets.BTC!.position!.profitState, 'UNPROVEN')

  // positionPnlR 2.5, sampledMfeR 2.5 -> giveback 0 -> PROVEN
  const proven = buildPortfolioState([], [managementCandidate({ currentPrice: 120, aggressive: aggressiveContext({ sampledMfeR: 2.5 }) })], 10_000, 8_000, 0.3, '2026-09-22T12:00:00.000Z')
  assertEquals(proven.assets.BTC!.position!.profitState, 'PROVEN')

  // positionPnlR 0 (currentPrice back to entry), sampledMfeR 2.0 -> giveback ratio 1.0 -> GIVING_BACK
  const givingBack = buildPortfolioState([], [managementCandidate({ currentPrice: 100, aggressive: aggressiveContext({ sampledMfeR: 2.0 }) })], 10_000, 8_000, 0.3, '2026-09-22T12:00:00.000Z')
  assertEquals(givingBack.assets.BTC!.position!.profitState, 'GIVING_BACK')
})

Deno.test('Aggressive snapshot: sampledMfeR null (never sampled yet) produces UNPROVEN and no giveback figures', () => {
  const state = buildPortfolioState([], [managementCandidate({ aggressive: aggressiveContext({ sampledMfeR: null }) })], 10_000, 8_000, 0.3, '2026-09-22T12:00:00.000Z')
  const position = state.assets.BTC!.position!
  assertEquals(position.sampledMfeR, undefined)
  assertEquals(position.givebackR, undefined)
  assertEquals(position.givebackRatio, undefined)
  assertEquals(position.profitState, 'UNPROVEN')
})

// --- isProtectionActionable / the MODIFY_PROTECTION dead-end fix
// (migration plan §4.3, the live ETH case) ----------------------------------

Deno.test('isProtectionActionable: true when the candidate stop is both tighter AND on the safe side of current price', () => {
  // entry 100, stop 90, current 120 -> candidate 99.5: tighter than 90, and 99.5 < 120 -> actionable
  assertEquals(isProtectionActionable(managementCandidate({ entryPrice: 100, stopLossPrice: 90, currentPrice: 120, minStopLossPct: 0.005 })), true)
})

Deno.test('isProtectionActionable: false when underwater — the exact live ETH case that prompted this fix', () => {
  // entry 100, stop 97, current 98 (below entry, still above stop): candidate 99.5 is
  // tighter than 97, BUT 99.5 >= 98 (current price) -> would stop out immediately -> NOT actionable
  assertEquals(isProtectionActionable(managementCandidate({ entryPrice: 100, stopLossPrice: 97, currentPrice: 98, minStopLossPct: 0.005 })), false)
})

Deno.test('isProtectionActionable: false when the candidate stop would not even be tighter than the current stop', () => {
  // stop already tightened past where TIGHTEN_TOWARD_ENTRY's own formula would land
  assertEquals(isProtectionActionable(managementCandidate({ entryPrice: 100, stopLossPrice: 99.6, currentPrice: 120, minStopLossPct: 0.005 })), false)
})

Deno.test('buildManagementQuestions: MODIFY_PROTECTION is OMITTED from action criteria when no legal tighten exists', () => {
  const underwater = managementCandidate({ entryPrice: 100, stopLossPrice: 97, currentPrice: 98, minStopLossPct: 0.005 })
  const questions = buildManagementQuestions([underwater])
  const action = questions[managementActionQuestionId('BTC')]!
  assertEquals(action.type, 'choice')
  if (action.type === 'choice') assertEquals(Object.keys(action.criteria).sort(), ['ADD', 'CLOSE', 'HOLD', 'REDUCE'])
})

Deno.test('buildManagementQuestions: MODIFY_PROTECTION is present when a legal tighten exists (the default fixture)', () => {
  const questions = buildManagementQuestions([managementCandidate()])
  const action = questions[managementActionQuestionId('BTC')]!
  assertEquals(action.type, 'choice')
  if (action.type === 'choice') assertEquals(Object.keys(action.criteria).sort(), ['ADD', 'CLOSE', 'HOLD', 'MODIFY_PROTECTION', 'REDUCE'])
})

// --- The reframed action question (migration plan §4.2) --------------------

Deno.test("Balanced's action question instructions are UNCHANGED (the exact pre-2026-09-23 wording)", () => {
  const questions = buildManagementQuestions([managementCandidate()])
  const action = questions[managementActionQuestionId('BTC')]!
  assertEquals(
    action.instructions,
    'Given the current state of the open BTC position (its entry, current price, unrealized P&L, protection levels, holding time, and any relevant news), what should happen to it right now?',
  )
})

Deno.test('Aggressive action question is reframed around marginal return, not "are you bullish?" — quotes the R metrics, not just PnL%', () => {
  const questions = buildManagementQuestions([managementCandidate({ aggressive: aggressiveContext() })])
  const action = questions[managementActionQuestionId('BTC')]!
  assertEquals(action.instructions.includes('bullish'), false)
  assertEquals(action.instructions.includes('2.50R'), true) // positionPnlR
  assertEquals(action.instructions.includes('best point of 2.00R'), true) // sampledMfeR
})

// --- The new remaining_upside question (migration plan §4.4) ---------------

Deno.test('remaining_upside is asked ONLY for an Aggressive candidate, never for Balanced — 6 questions vs 5', () => {
  const balanced = buildManagementQuestions([managementCandidate()])
  assertEquals(Object.keys(balanced).length, 5)
  assertEquals(remainingUpsideQuestionId('BTC') in balanced, false)

  const aggressive = buildManagementQuestions([managementCandidate({ aggressive: aggressiveContext() })])
  assertEquals(Object.keys(aggressive).length, 6)
  const remainingUpside = aggressive[remainingUpsideQuestionId('BTC')]!
  assertEquals(remainingUpside.type, 'score')
  if (remainingUpside.type === 'score') assertEquals(remainingUpside.criteria.length, 4) // same 4 levels as the entry path's expected_move
})
