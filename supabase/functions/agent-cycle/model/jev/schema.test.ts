import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { expectChoice, expectNoul, expectScore, JevOutputShapeError, parseJevResponse } from './schema.ts'

function response(overrides: Record<string, unknown> = {}) {
  return {
    model: 'jev-1.13.0',
    answers: {
      veto_btc: { type: 'noul', noul: 0.12 },
    },
    usage: { input_tokens: 200, output_tokens: 20 },
    ...overrides,
  }
}

Deno.test('parseJevResponse: a valid single answer round-trips cleanly', () => {
  const result = parseJevResponse(response(), ['veto_btc'])
  assertEquals(result.modelVersion, 'jev-1.13.0')
  assertEquals(result.answers.length, 1)
  assertEquals(result.answers[0], { questionId: 'veto_btc', type: 'noul', noul: 0.12 })
})

Deno.test('parseJevResponse: multiple candidates in one batched call all round-trip', () => {
  const result = parseJevResponse(
    response({ answers: { veto_btc: { type: 'noul', noul: 0.10 }, veto_eth: { type: 'noul', noul: 0.91 } } }),
    ['veto_btc', 'veto_eth'],
  )
  assertEquals(result.answers.length, 2)
  const eth = result.answers.find((a) => a.questionId === 'veto_eth')!
  assertEquals(expectNoul(eth), 0.91)
})

Deno.test('parseJevResponse: usage is optional — absence does not fail parsing', () => {
  const { usage: _drop, ...withoutUsage } = response()
  const result = parseJevResponse(withoutUsage, ['veto_btc'])
  assertEquals(result.answers.length, 1)
})

Deno.test('parseJevResponse: missing an expected answer throws', () => {
  assertThrows(
    () => parseJevResponse(response(), ['veto_btc', 'veto_eth']),
    JevOutputShapeError,
  )
})

Deno.test('parseJevResponse: an extra answer for a question that was not requested throws', () => {
  assertThrows(
    () => parseJevResponse(response({ answers: { veto_btc: { type: 'noul', noul: 0.1 }, veto_eth: { type: 'noul', noul: 0.2 } } }), ['veto_btc']),
    JevOutputShapeError,
  )
})

Deno.test('parseJevResponse: noul non-numeric throws rather than coercing', () => {
  assertThrows(
    () => parseJevResponse(response({ answers: { veto_btc: { type: 'noul', noul: 'high' } } }), ['veto_btc']),
    JevOutputShapeError,
  )
})

Deno.test('parseJevResponse: noul outside [0,1] throws — never clamped, never silently accepted', () => {
  assertThrows(
    () => parseJevResponse(response({ answers: { veto_btc: { type: 'noul', noul: 1.5 } } }), ['veto_btc']),
    JevOutputShapeError,
  )
  assertThrows(
    () => parseJevResponse(response({ answers: { veto_btc: { type: 'noul', noul: -0.1 } } }), ['veto_btc']),
    JevOutputShapeError,
  )
})

Deno.test('parseJevResponse: noul exactly at 0 or 1 is valid (boundary inclusive)', () => {
  assertEquals(expectNoul(parseJevResponse(response({ answers: { veto_btc: { type: 'noul', noul: 0 } } }), ['veto_btc']).answers[0]!), 0)
  assertEquals(expectNoul(parseJevResponse(response({ answers: { veto_btc: { type: 'noul', noul: 1 } } }), ['veto_btc']).answers[0]!), 1)
})

Deno.test('parseJevResponse: missing model field throws', () => {
  const { model: _drop, ...withoutModel } = response()
  assertThrows(() => parseJevResponse(withoutModel, ['veto_btc']), JevOutputShapeError)
})

Deno.test('parseJevResponse: a response that does not even match the raw envelope shape throws', () => {
  assertThrows(() => parseJevResponse({ answers: 'not an object' }, ['veto_btc']), JevOutputShapeError)
  assertThrows(() => parseJevResponse('not even an object', ['veto_btc']), JevOutputShapeError)
  assertThrows(() => parseJevResponse(null, ['veto_btc']), JevOutputShapeError)
})

Deno.test('parseJevResponse: empty candidates and empty answers is a valid degenerate case', () => {
  const result = parseJevResponse(response({ answers: {} }), [])
  assertEquals(result.answers, [])
})

Deno.test('parseJevResponse: a duplicate-looking key collision cannot occur (object keys are inherently unique) — exact-cardinality relies only on missing/extra, not duplicate detection', () => {
  // JS object literals can't carry a literal duplicate key at runtime, so
  // "duplicate answer" for Jev's map-shaped response degenerates to
  // "extra answer for an unexpected id" — already covered above. This
  // test documents that distinction rather than asserting new behavior.
  const result = parseJevResponse(response(), ['veto_btc'])
  assertEquals(result.answers.length, 1)
})

// --- Phase 2 (2026-09-22) — mixed Choice/Score answers ---------------------
//
// One request can now mix noul (a FLAT asset's veto) with choice/score
// (an OPEN asset's management questions) in the SAME envelope — these
// tests prove parseJevResponse handles a genuine mix, not just repeated
// noul answers.

Deno.test('parseJevResponse: a Choice answer parses with its full probability distribution and confidence', () => {
  const result = parseJevResponse(
    response({
      answers: {
        btc_action: { type: 'choice', choice: 'ADD', confidence: 0.82, probabilities: { HOLD: 0.1, ADD: 0.82, REDUCE: 0.04, CLOSE: 0.02, MODIFY_PROTECTION: 0.02 } },
      },
    }),
    ['btc_action'],
  )
  const answer = result.answers[0]!
  const choice = expectChoice(answer)
  assertEquals(choice.choice, 'ADD')
  assertEquals(choice.confidence, 0.82)
  assertEquals(choice.probabilities.ADD, 0.82)
})

Deno.test('parseJevResponse: a Score answer parses with its legend and probability distribution', () => {
  const result = parseJevResponse(
    response({
      answers: {
        btc_add_conviction: { type: 'score', score: 1.43, confidence: 0.35, legend: { '0': 'small', '1': 'medium', '2': 'large' }, probabilities: { '0': 0, '1': 0.57, '2': 0.43 } },
      },
    }),
    ['btc_add_conviction'],
  )
  const score = expectScore(result.answers[0]!)
  assertEquals(score.score, 1.43)
  assertEquals(score.confidence, 0.35)
  assertEquals(score.legend['1'], 'medium')
})

Deno.test('parseJevResponse: a genuinely mixed envelope (noul + choice + score together) parses cleanly, one request modeling both a FLAT veto and an OPEN management decision', () => {
  const result = parseJevResponse(
    response({
      answers: {
        veto_eth: { type: 'noul', noul: 0.12 },
        btc_action: { type: 'choice', choice: 'HOLD', confidence: 0.9, probabilities: { HOLD: 0.9, ADD: 0.05, REDUCE: 0.03, CLOSE: 0.01, MODIFY_PROTECTION: 0.01 } },
        btc_reduce_magnitude: { type: 'score', score: 0, confidence: 0.9, legend: { '0': 'small', '1': 'medium', '2': 'large' }, probabilities: { '0': 0.9, '1': 0.1, '2': 0 } },
      },
    }),
    ['veto_eth', 'btc_action', 'btc_reduce_magnitude'],
  )
  assertEquals(result.answers.length, 3)
  const byId = new Map(result.answers.map((a) => [a.questionId, a]))
  assertEquals(expectNoul(byId.get('veto_eth')!), 0.12)
  assertEquals(expectChoice(byId.get('btc_action')!).choice, 'HOLD')
  assertEquals(expectScore(byId.get('btc_reduce_magnitude')!).score, 0)
})

Deno.test('expectNoul/expectChoice/expectScore: each throws a JevOutputShapeError when the answer is a different type than expected', () => {
  const result = parseJevResponse(response({ answers: { btc_action: { type: 'choice', choice: 'HOLD', confidence: 0.9, probabilities: { HOLD: 1 } } } }), ['btc_action'])
  const answer = result.answers[0]!
  assertThrows(() => expectNoul(answer), JevOutputShapeError)
  assertThrows(() => expectScore(answer), JevOutputShapeError)
  // expectChoice on the actual choice answer does NOT throw — sanity check that the negative assertions above are meaningful.
  expectChoice(answer)
})
