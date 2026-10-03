import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1'
import { computeCaseId, computeEvaluationId, caseInputFromRequestProjection } from './case-identity.ts'
import type { JevRequestProjection } from './request-projection.ts'
import { vetoQuestionId } from './question.ts'
import { entryQualityQuestionId, expectedMoveQuestionId } from './entry-question.ts'
import { failureRiskQuestionId, failureModeQuestionId } from './adversarial-question.ts'

function projection(overrides: Partial<JevRequestProjection> = {}): JevRequestProjection {
  return {
    schemaVersion: 'v1',
    asset: 'BTC',
    modelRequested: 'jev-1.13.0',
    modelResolved: 'jev-1.13.0',
    evaluatedAt: '2026-10-03T12:00:00.000Z',
    news: [{ source: 'Cointelegraph', headline: 'Test', summary: null, publishedAt: '2026-10-03T11:00:00.000Z', ageMinutes: 60 }],
    position: null,
    opportunity: null,
    portfolio: null,
    questions: { [vetoQuestionId('BTC')]: { type: 'noul', instructions: 'x', criteria: { true: 'y', false: 'n' } } },
    ...overrides,
  }
}

// --- case_id: depends ONLY on the market situation ------------------------

Deno.test('computeCaseId: identical market situation produces the identical case_id, regardless of which model/questions were asked — THE decisive property', async () => {
  const champion = projection({ modelRequested: 'jev-1.13.0', questions: { [vetoQuestionId('BTC')]: { type: 'noul', instructions: 'champion wording', criteria: { true: 'y', false: 'n' } } } })
  const challenger = projection({ modelRequested: 'jev-2.0.0', questions: { [entryQualityQuestionId('BTC')]: { type: 'choice', instructions: 'challenger wording', criteria: { ENTER: 'y', SKIP: 'n' } } } })
  const championCaseId = await computeCaseId(caseInputFromRequestProjection(champion))
  const challengerCaseId = await computeCaseId(caseInputFromRequestProjection(challenger))
  assertEquals(championCaseId, challengerCaseId, 'case_id must be identical for the same market situation even when model/questions differ entirely')
})

Deno.test('computeCaseId: a genuinely different market situation (different news) produces a different case_id', async () => {
  const a = projection({ news: [{ source: 'X', headline: 'Headline A', summary: null, publishedAt: '2026-10-03T11:00:00.000Z', ageMinutes: 60 }] })
  const b = projection({ news: [{ source: 'X', headline: 'Headline B', summary: null, publishedAt: '2026-10-03T11:00:00.000Z', ageMinutes: 60 }] })
  const idA = await computeCaseId(caseInputFromRequestProjection(a))
  const idB = await computeCaseId(caseInputFromRequestProjection(b))
  assertNotEquals(idA, idB)
})

Deno.test('computeCaseId: a different asset produces a different case_id, even with identical news/position/opportunity', async () => {
  const btc = projection({ asset: 'BTC' })
  const eth = projection({ asset: 'ETH' })
  const idBtc = await computeCaseId(caseInputFromRequestProjection(btc))
  const idEth = await computeCaseId(caseInputFromRequestProjection(eth))
  assertNotEquals(idBtc, idEth)
})

Deno.test('computeCaseId: a different evaluatedAt timestamp produces a different case_id — the SAME news at a different moment is a different market situation', async () => {
  const t1 = projection({ evaluatedAt: '2026-10-03T12:00:00.000Z' })
  const t2 = projection({ evaluatedAt: '2026-10-03T13:00:00.000Z' })
  const id1 = await computeCaseId(caseInputFromRequestProjection(t1))
  const id2 = await computeCaseId(caseInputFromRequestProjection(t2))
  assertNotEquals(id1, id2)
})

Deno.test('computeCaseId: deterministic — recomputing from the same projection twice gives the same id', async () => {
  const p = projection()
  const idA = await computeCaseId(caseInputFromRequestProjection(p))
  const idB = await computeCaseId(caseInputFromRequestProjection(p))
  assertEquals(idA, idB)
})

// --- evaluation_id: depends on case_id + model + prompt + config ----------

Deno.test('computeEvaluationId: same case, same model, same prompt family, same config -> same evaluation_id', async () => {
  const p = projection()
  const caseId = await computeCaseId(caseInputFromRequestProjection(p))
  const idA = await computeEvaluationId(caseId, p)
  const idB = await computeEvaluationId(caseId, p)
  assertEquals(idA, idB)
})

Deno.test('computeEvaluationId: the champion/challenger worked example — IDENTICAL case_id, DIFFERENT evaluation_id, when inferenceConfig differs', async () => {
  const p = projection()
  const caseId = await computeCaseId(caseInputFromRequestProjection(p))
  const championEval = await computeEvaluationId(caseId, p, { variant: 'champion-v1' })
  const challengerEval = await computeEvaluationId(caseId, p, { variant: 'challenger-v2' })
  assertNotEquals(championEval, challengerEval, 'two evaluations of the identical case must get different evaluation_ids when anything that can affect output differs')
  // And the pairing property itself: both still trace back to the same case.
  assertEquals(caseId, await computeCaseId(caseInputFromRequestProjection(p)))
})

Deno.test('computeEvaluationId: a different resolved model id (same case) produces a different evaluation_id', async () => {
  const p = projection()
  const caseId = await computeCaseId(caseInputFromRequestProjection(p))
  const idJev1 = await computeEvaluationId(caseId, { ...p, modelResolved: 'jev-1.13.0' })
  const idJev2 = await computeEvaluationId(caseId, { ...p, modelResolved: 'jev-2.0.0' })
  assertNotEquals(idJev1, idJev2)
})

Deno.test('computeEvaluationId: falls back to modelRequested when modelResolved is null', async () => {
  const p = projection({ modelRequested: 'jev-latest', modelResolved: null })
  const caseId = await computeCaseId(caseInputFromRequestProjection(p))
  // Must not throw, and must differ from a resolved-id evaluation of the same case.
  const idUnresolved = await computeEvaluationId(caseId, p)
  const idResolved = await computeEvaluationId(caseId, { ...p, modelRequested: 'jev-latest', modelResolved: 'jev-1.13.0' })
  assertNotEquals(idUnresolved, idResolved)
})

Deno.test('computeEvaluationId: a row that asked veto only vs one that asked entry only get different prompt-hash components, hence different evaluation_id, even on the same case/model', async () => {
  const p = projection()
  const caseId = await computeCaseId(caseInputFromRequestProjection(p))
  const vetoOnly = { ...p, questions: { [vetoQuestionId('BTC')]: { type: 'noul' as const, instructions: 'x', criteria: { true: 'y', false: 'n' } } } }
  const entryOnly = {
    ...p,
    questions: {
      [entryQualityQuestionId('BTC')]: { type: 'choice' as const, instructions: 'x', criteria: { ENTER: 'y', SKIP: 'n' } },
      [expectedMoveQuestionId('BTC')]: { type: 'score' as const, instructions: 'x', criteria: ['a'] },
    },
  }
  const idVeto = await computeEvaluationId(caseId, vetoOnly)
  const idEntry = await computeEvaluationId(caseId, entryOnly)
  assertNotEquals(idVeto, idEntry)
})

Deno.test('computeEvaluationId: multiple families asked in one row (veto + adversarial) produces a stable id regardless of how the questions object was constructed', async () => {
  const p1 = projection({
    questions: {
      [vetoQuestionId('BTC')]: { type: 'noul', instructions: 'x', criteria: { true: 'y', false: 'n' } },
      [failureRiskQuestionId('BTC')]: { type: 'choice', instructions: 'x', criteria: { LOW: 'y' } },
      [failureModeQuestionId('BTC')]: { type: 'choice', instructions: 'x', criteria: { NONE: 'y' } },
    },
  })
  // Same questions, built in a different insertion order.
  const p2 = projection({
    questions: {
      [failureModeQuestionId('BTC')]: { type: 'choice', instructions: 'x', criteria: { NONE: 'y' } },
      [vetoQuestionId('BTC')]: { type: 'noul', instructions: 'x', criteria: { true: 'y', false: 'n' } },
      [failureRiskQuestionId('BTC')]: { type: 'choice', instructions: 'x', criteria: { LOW: 'y' } },
    },
  })
  const caseId = await computeCaseId(caseInputFromRequestProjection(p1))
  const id1 = await computeEvaluationId(caseId, p1)
  const id2 = await computeEvaluationId(caseId, p2)
  assertEquals(id1, id2, 'family presence, not object insertion order, must determine the prompt-hash component')
})

Deno.test('caseInputFromRequestProjection: excludes modelRequested/modelResolved/questions/schemaVersion — only the market-situation fields survive', () => {
  const p = projection()
  const caseInput = caseInputFromRequestProjection(p)
  assertEquals(Object.keys(caseInput).sort(), ['asset', 'evaluatedAt', 'news', 'opportunity', 'portfolio', 'position'].sort())
})
