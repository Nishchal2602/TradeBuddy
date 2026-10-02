import { assertEquals } from 'jsr:@std/assert@1'
import { buildEntryQuestionsForAsset, entryQualityQuestionId, expectedMoveQuestionId, expectedMovePctFromScore, EXPECTED_MOVE_PCT_BY_SCORE_LEVEL } from './entry-question.ts'
import type { EntryOpportunityInput } from './entry-question.ts'

function opportunity(overrides: Partial<EntryOpportunityInput> = {}): EntryOpportunityInput {
  return {
    asset: 'BTC',
    kind: 'MOMENTUM_BREAKOUT',
    atrTargetDistancePct: 0.016,
    estimatedRoundTripCostPct: 0.003,
    ret15mPct: 0.5,
    ret30mPct: 1.0,
    ret60mPct: 1.5,
    realizedVol5m: 0.001,
    volumeTrendRatio: 1.2,
    sampledDayHighPct: -0.5,
    sampledDayLowPct: 3.0,
    ...overrides,
  }
}

Deno.test('entryQualityQuestionId / expectedMoveQuestionId: deterministic, lowercase, asset-prefixed', () => {
  assertEquals(entryQualityQuestionId('BTC'), 'btc_entry_quality')
  assertEquals(expectedMoveQuestionId('ETH'), 'eth_expected_move')
})

Deno.test('buildEntryQuestionsForAsset: produces exactly the two questions, correctly typed', () => {
  const questions = buildEntryQuestionsForAsset(opportunity({ asset: 'BTC' }))
  assertEquals(Object.keys(questions).sort(), ['btc_entry_quality', 'btc_expected_move'])
  assertEquals(questions.btc_entry_quality!.type, 'choice')
  assertEquals(questions.btc_expected_move!.type, 'score')
})

Deno.test('buildEntryQuestionsForAsset: entry_quality criteria are ENTER/SKIP only — a choice, never a direction', () => {
  const questions = buildEntryQuestionsForAsset(opportunity({ asset: 'BTC' }))
  const q = questions.btc_entry_quality!
  if (q.type !== 'choice') throw new Error('unreachable')
  assertEquals(Object.keys(q.criteria).sort(), ['ENTER', 'SKIP'])
})

Deno.test('buildEntryQuestionsForAsset: expected_move asks for degree, never a raw number, and is scoped to the named asset', () => {
  const questions = buildEntryQuestionsForAsset(opportunity({ asset: 'ETH' }))
  const q = questions.eth_expected_move!
  if (q.type !== 'score') throw new Error('unreachable')
  assertEquals(q.criteria.length, 4)
  assertEquals(q.instructions.includes('ETH'), true)
})

// --- Strategy V4 (2026-10-02, plan §5.1b/§5.2 point 2) — shared opportunity object, context-aware wording ---

Deno.test('buildEntryQuestionsForAsset: an Aggressive-shaped opportunity (no armId/direction/bias) produces BYTE-IDENTICAL text to the pre-2026-10-02 wording — regression guard', () => {
  const questions = buildEntryQuestionsForAsset(opportunity({ asset: 'BTC' }))
  const entryQuality = questions.btc_entry_quality!
  const expectedMove = questions.btc_expected_move!
  assertEquals(
    entryQuality.instructions,
    'A deterministic short-horizon opportunity was just detected on BTC. Given the recent price action, momentum, volatility, and cost of trading, is this genuinely worth entering right now?',
  )
  assertEquals(
    expectedMove.instructions,
    'If a new BTC position were opened right now, how large a favorable move do you expect over the next 15-60 minutes?',
  )
})

Deno.test('buildEntryQuestionsForAsset: a V4 opportunity (armId+direction+bias present) names the direction, arm, and bias in entry_quality, never in expected_move', () => {
  const questions = buildEntryQuestionsForAsset(opportunity({ asset: 'ETH', kind: undefined, armId: 'breakout_short', direction: 'short', bias: 'SHORT' }))
  const entryQuality = questions.eth_entry_quality!
  const expectedMove = questions.eth_expected_move!
  assertEquals(entryQuality.instructions.includes('short breakout_short candidate under SHORT bias'), true)
  // expected_move's wording is unchanged by V4 context — only entry_quality's is.
  assertEquals(
    expectedMove.instructions,
    'If a new ETH position were opened right now, how large a favorable move do you expect over the next 15-60 minutes?',
  )
})

Deno.test('buildEntryQuestionsForAsset: armId/direction/bias must be present TOGETHER to add context — any one alone leaves wording unchanged', () => {
  const onlyDirection = buildEntryQuestionsForAsset(opportunity({ asset: 'BTC', direction: 'long' }))
  const onlyArmId = buildEntryQuestionsForAsset(opportunity({ asset: 'BTC', armId: 'pullback_long' }))
  const onlyBias = buildEntryQuestionsForAsset(opportunity({ asset: 'BTC', bias: 'LONG' }))
  const baseline = 'A deterministic short-horizon opportunity was just detected on BTC. Given the recent price action, momentum, volatility, and cost of trading, is this genuinely worth entering right now?'
  assertEquals(onlyDirection.btc_entry_quality!.instructions, baseline)
  assertEquals(onlyArmId.btc_entry_quality!.instructions, baseline)
  assertEquals(onlyBias.btc_entry_quality!.instructions, baseline)
})

Deno.test('expectedMovePctFromScore: rounds to the nearest pre-registered level, never returns a raw model number', () => {
  assertEquals(expectedMovePctFromScore(0), EXPECTED_MOVE_PCT_BY_SCORE_LEVEL[0])
  assertEquals(expectedMovePctFromScore(1.4), EXPECTED_MOVE_PCT_BY_SCORE_LEVEL[1])
  assertEquals(expectedMovePctFromScore(3), EXPECTED_MOVE_PCT_BY_SCORE_LEVEL[3])
})

Deno.test('expectedMovePctFromScore: clamps out-of-range scores rather than throwing or extrapolating', () => {
  assertEquals(expectedMovePctFromScore(-5), EXPECTED_MOVE_PCT_BY_SCORE_LEVEL[0])
  assertEquals(expectedMovePctFromScore(99), EXPECTED_MOVE_PCT_BY_SCORE_LEVEL[3])
})

Deno.test('EXPECTED_MOVE_PCT_BY_SCORE_LEVEL: monotonically increasing — a higher score level always means a larger expected move', () => {
  for (let i = 1; i < EXPECTED_MOVE_PCT_BY_SCORE_LEVEL.length; i++) {
    assertEquals(EXPECTED_MOVE_PCT_BY_SCORE_LEVEL[i]! > EXPECTED_MOVE_PCT_BY_SCORE_LEVEL[i - 1]!, true)
  }
})
