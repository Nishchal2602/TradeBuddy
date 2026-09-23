import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1'
import { buildJevQuestions, buildJevState, JEV_QUESTION_VERSION, JEV_VETO_THRESHOLD, vetoQuestionId } from './question.ts'
import type { VetoCandidateInput } from '../payload.ts'

function candidate(overrides: Partial<VetoCandidateInput> = {}): VetoCandidateInput {
  return {
    asset: 'BTC',
    news: [
      { id: 'news-uuid-1', source: 'Cointelegraph', headline: 'Bitcoin ETF sees inflows', summary: 'Spot ETFs recorded net inflows.', publishedAt: '2026-09-22T08:00:00.000Z', ageMinutes: 60 },
    ],
    ...overrides,
  }
}

// --- buildJevState -----------------------------------------------------

Deno.test('buildJevState: keys news by asset', () => {
  const state = buildJevState([candidate({ asset: 'BTC' })], '2026-09-22T09:00:00.000Z')
  assertEquals(Object.keys(state.assets), ['BTC'])
  assertEquals(state.assets.BTC!.news.length, 1)
})

Deno.test('buildJevState: both assets present in one shared state (not split into two states)', () => {
  const state = buildJevState(
    [candidate({ asset: 'BTC' }), candidate({ asset: 'ETH', news: [] })],
    '2026-09-22T09:00:00.000Z',
  )
  assertEquals(Object.keys(state.assets).sort(), ['BTC', 'ETH'])
  assertEquals(state.assets.ETH!.news, [])
})

Deno.test('buildJevState: drops news[].id — an internal news_items UUID with zero decision value', () => {
  const state = buildJevState([candidate()], '2026-09-22T09:00:00.000Z')
  const newsItem = state.assets.BTC!.news[0]!
  assertEquals(Object.hasOwn(newsItem, 'id'), false)
  assertEquals(Object.keys(newsItem).sort(), ['ageMinutes', 'headline', 'publishedAt', 'source', 'summary'])
})

Deno.test('buildJevState: never carries regime, stopLossPct, or takeProfitPct — the fields are structurally absent from VetoCandidateInput itself, not merely unread', () => {
  const state = buildJevState([candidate()], '2026-09-22T09:00:00.000Z')
  const serialized = JSON.stringify(state)
  assertEquals(serialized.includes('stopLoss'), false)
  assertEquals(serialized.includes('takeProfit'), false)
  assertEquals(serialized.includes('dailyMa'), false)
})

Deno.test('buildJevState: carries evaluatedAt as the freshness anchor', () => {
  const state = buildJevState([candidate()], '2026-09-22T09:00:00.000Z')
  assertEquals(state.evaluatedAt, '2026-09-22T09:00:00.000Z')
})

Deno.test('buildJevState: news content (source/headline/summary/publishedAt/ageMinutes) is preserved verbatim', () => {
  const state = buildJevState([candidate()], '2026-09-22T09:00:00.000Z')
  assertEquals(state.assets.BTC!.news[0], {
    source: 'Cointelegraph',
    headline: 'Bitcoin ETF sees inflows',
    summary: 'Spot ETFs recorded net inflows.',
    publishedAt: '2026-09-22T08:00:00.000Z',
    ageMinutes: 60,
  })
})

// --- buildJevQuestions ---------------------------------------------------

Deno.test('buildJevQuestions: one noul question per candidate, keyed by vetoQuestionId(asset)', () => {
  const questions = buildJevQuestions([candidate({ asset: 'BTC' }), candidate({ asset: 'ETH' })])
  assertEquals(Object.keys(questions).sort(), ['veto_btc', 'veto_eth'])
  assertEquals(questions.veto_btc!.type, 'noul')
  assertEquals(questions.veto_eth!.type, 'noul')
})

Deno.test('buildJevQuestions: instructions are scoped to the specific asset by name', () => {
  const questions = buildJevQuestions([candidate({ asset: 'BTC' })])
  assertEquals(questions.veto_btc!.instructions.includes('BTC'), true)
})

Deno.test('buildJevQuestions: criteria distinguish material exogenous events from price commentary', () => {
  const questions = buildJevQuestions([candidate({ asset: 'BTC' })])
  assertEquals(questions.veto_btc!.criteria.true.toLowerCase().includes('hack'), true)
  assertEquals(questions.veto_btc!.criteria.false.toLowerCase().includes('commentary'), true)
})

Deno.test('buildJevQuestions: zero candidates produces zero questions (the zero-call path relies on this)', () => {
  assertEquals(buildJevQuestions([]), {})
})

// --- vetoQuestionId -------------------------------------------------------

Deno.test('vetoQuestionId: deterministic, lowercase, asset-prefixed', () => {
  assertEquals(vetoQuestionId('BTC'), 'veto_btc')
  assertEquals(vetoQuestionId('ETH'), 'veto_eth')
})

// --- Threshold / version constants ---------------------------------------

Deno.test('JEV_VETO_THRESHOLD: is the documented provisional starting value', () => {
  assertEquals(JEV_VETO_THRESHOLD, 0.70)
})

Deno.test('JEV_QUESTION_VERSION: encodes the threshold, so a later threshold change is visible in persisted provenance', () => {
  assertEquals(JEV_QUESTION_VERSION, 'jev-veto-v1/t0.70')
})

Deno.test('JEV_QUESTION_VERSION and JEV_VETO_THRESHOLD stay in sync (regression guard against editing one without the other)', () => {
  assertNotEquals(JEV_QUESTION_VERSION.includes(JEV_VETO_THRESHOLD.toFixed(2)), false)
})
