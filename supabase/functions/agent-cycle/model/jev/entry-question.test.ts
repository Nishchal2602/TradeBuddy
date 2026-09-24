import { assertEquals } from 'jsr:@std/assert@1'
import { buildEntryQuestionsForAsset, entryQualityQuestionId, expectedMoveQuestionId, expectedMovePctFromScore, EXPECTED_MOVE_PCT_BY_SCORE_LEVEL } from './entry-question.ts'

Deno.test('entryQualityQuestionId / expectedMoveQuestionId: deterministic, lowercase, asset-prefixed', () => {
  assertEquals(entryQualityQuestionId('BTC'), 'btc_entry_quality')
  assertEquals(expectedMoveQuestionId('ETH'), 'eth_expected_move')
})

Deno.test('buildEntryQuestionsForAsset: produces exactly the two Aggressive-only questions, correctly typed', () => {
  const questions = buildEntryQuestionsForAsset('BTC')
  assertEquals(Object.keys(questions).sort(), ['btc_entry_quality', 'btc_expected_move'])
  assertEquals(questions.btc_entry_quality!.type, 'choice')
  assertEquals(questions.btc_expected_move!.type, 'score')
})

Deno.test('buildEntryQuestionsForAsset: entry_quality criteria are ENTER/SKIP only — a choice, never a direction', () => {
  const questions = buildEntryQuestionsForAsset('BTC')
  const q = questions.btc_entry_quality!
  if (q.type !== 'choice') throw new Error('unreachable')
  assertEquals(Object.keys(q.criteria).sort(), ['ENTER', 'SKIP'])
})

Deno.test('buildEntryQuestionsForAsset: expected_move asks for degree, never a raw number, and is scoped to the named asset', () => {
  const questions = buildEntryQuestionsForAsset('ETH')
  const q = questions.eth_expected_move!
  if (q.type !== 'score') throw new Error('unreachable')
  assertEquals(q.criteria.length, 4)
  assertEquals(q.instructions.includes('ETH'), true)
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
