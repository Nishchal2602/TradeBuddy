import { assertEquals } from 'jsr:@std/assert@1'
import { buildAdversarialQuestionsForAsset, failureModeQuestionId, failureRiskQuestionId, VALID_FAILURE_MODES, ADVERSARIAL_QUESTION_VERSION } from './adversarial-question.ts'
import type { EntryOpportunityInput } from './entry-question.ts'

function opportunity(overrides: Partial<EntryOpportunityInput> = {}): EntryOpportunityInput {
  return {
    asset: 'BTC',
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

Deno.test('failureRiskQuestionId / failureModeQuestionId: deterministic, lowercase, asset-prefixed', () => {
  assertEquals(failureRiskQuestionId('BTC'), 'btc_failure_risk')
  assertEquals(failureModeQuestionId('ETH'), 'eth_failure_mode')
})

Deno.test('buildAdversarialQuestionsForAsset: produces exactly two Choice questions, correctly keyed', () => {
  const questions = buildAdversarialQuestionsForAsset(opportunity({ asset: 'BTC' }))
  assertEquals(Object.keys(questions).sort(), ['btc_failure_mode', 'btc_failure_risk'])
  assertEquals(questions.btc_failure_risk!.type, 'choice')
  assertEquals(questions.btc_failure_mode!.type, 'choice')
})

Deno.test('buildAdversarialQuestionsForAsset: failure_risk criteria are exactly LOW/MEDIUM/HIGH', () => {
  const q = buildAdversarialQuestionsForAsset(opportunity())['btc_failure_risk']!
  if (q.type !== 'choice') throw new Error('unreachable')
  assertEquals(Object.keys(q.criteria).sort(), ['HIGH', 'LOW', 'MEDIUM'])
})

Deno.test('buildAdversarialQuestionsForAsset: failure_mode criteria match VALID_FAILURE_MODES exactly, including NONE', () => {
  const q = buildAdversarialQuestionsForAsset(opportunity())['btc_failure_mode']!
  if (q.type !== 'choice') throw new Error('unreachable')
  assertEquals(Object.keys(q.criteria).sort(), [...VALID_FAILURE_MODES].sort())
  assertEquals('NONE' in q.criteria, true)
})

Deno.test("buildAdversarialQuestionsForAsset: NONE's own criteria text states it means 'no vulnerability visible' — NOT 'unsure' and NOT 'none of the above fit'", () => {
  const q = buildAdversarialQuestionsForAsset(opportunity())['btc_failure_mode']!
  if (q.type !== 'choice') throw new Error('unreachable')
  const noneText = q.criteria.NONE!.toLowerCase()
  assertEquals(noneText.includes('no material, specific vulnerability'), true)
  assertEquals(noneText.includes('does not mean'), true)
  assertEquals(noneText.includes('unsure'), true)
})

Deno.test('buildAdversarialQuestionsForAsset: both questions restate the adversarial premise ("assume this candidate is going to fail") independently — Jev evaluates questions in isolation', () => {
  const questions = buildAdversarialQuestionsForAsset(opportunity({ asset: 'BTC' }))
  assertEquals(questions.btc_failure_risk!.instructions.includes('Assume this candidate is going to fail'), true)
  assertEquals(questions.btc_failure_mode!.instructions.includes('Assume this candidate is going to fail'), true)
})

Deno.test('buildAdversarialQuestionsForAsset: scoped to the named asset', () => {
  const questions = buildAdversarialQuestionsForAsset(opportunity({ asset: 'ETH' }))
  assertEquals(questions.eth_failure_risk!.instructions.includes('ETH'), true)
  assertEquals(questions.eth_failure_mode!.instructions.includes('ETH'), true)
})

Deno.test('buildAdversarialQuestionsForAsset: armId+direction+bias present together names the candidate context in both questions', () => {
  const questions = buildAdversarialQuestionsForAsset(opportunity({ asset: 'BTC', armId: 'fade_long', direction: 'long', bias: 'NEUTRAL' }))
  assertEquals(questions.btc_failure_risk!.instructions.includes('long fade_long candidate under NEUTRAL bias'), true)
  assertEquals(questions.btc_failure_mode!.instructions.includes('long fade_long candidate under NEUTRAL bias'), true)
})

Deno.test('buildAdversarialQuestionsForAsset: no armId/direction/bias (Aggressive-shaped) adds no context suffix', () => {
  const questions = buildAdversarialQuestionsForAsset(opportunity({ asset: 'BTC' }))
  assertEquals(questions.btc_failure_risk!.instructions.includes('candidate under'), false)
})

Deno.test('ADVERSARIAL_QUESTION_VERSION: a non-empty, versioned string, independent of the other two prompt versions', () => {
  assertEquals(ADVERSARIAL_QUESTION_VERSION.length > 0, true)
  assertEquals(ADVERSARIAL_QUESTION_VERSION.includes('adversarial'), true)
})

Deno.test('VALID_FAILURE_MODES: exactly six modes, NONE last', () => {
  assertEquals(VALID_FAILURE_MODES.length, 6)
  assertEquals(VALID_FAILURE_MODES[VALID_FAILURE_MODES.length - 1], 'NONE')
})
