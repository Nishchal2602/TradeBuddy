import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { projectJevRequestForAsset, JEV_REQUEST_PROJECTION_SCHEMA_VERSION } from './request-projection.ts'
import type { JevRawRequest } from './provider.ts'
import type { JevState, JevPositionSnapshot, JevOpportunitySnapshot } from './question.ts'
import { vetoQuestionId } from './question.ts'
import { managementActionQuestionId, addConvictionQuestionId, remainingUpsideQuestionId } from './management-question.ts'
import { entryQualityQuestionId, expectedMoveQuestionId } from './entry-question.ts'
import { failureRiskQuestionId, failureModeQuestionId } from './adversarial-question.ts'

function positionSnapshot(overrides: Partial<JevPositionSnapshot> = {}): JevPositionSnapshot {
  return {
    direction: 'long',
    entryPrice: 100,
    currentPrice: 120,
    quantity: 10,
    notionalUsd: 1200,
    unrealizedPnlPct: 0.2,
    unrealizedPnlUsd: 200,
    estimatedRoundTripCostPct: 0.003,
    heldHours: 12,
    stopLossPrice: 90,
    takeProfitPrice: 180,
    distanceToStopPct: 0.25,
    distanceToTakeProfitPct: 0.5,
    ...overrides,
  }
}

function opportunitySnapshot(overrides: Partial<JevOpportunitySnapshot> = {}): JevOpportunitySnapshot {
  return {
    atrTargetDistancePct: 0.02,
    estimatedRoundTripCostPct: 0.003,
    ret15mPct: 0.1,
    ret30mPct: 0.2,
    ret60mPct: 0.3,
    realizedVol5m: 0.01,
    volumeTrendRatio: 1.1,
    sampledDayHighPct: 1,
    sampledDayLowPct: -1,
    ...overrides,
  }
}

function rawRequest(overrides: Partial<JevRawRequest> = {}): JevRawRequest {
  const state: JevState = {
    evaluatedAt: '2026-10-03T12:00:00.000Z',
    assets: {
      BTC: { news: [{ source: 'Cointelegraph', headline: 'Test', summary: null, publishedAt: '2026-10-03T11:00:00.000Z', ageMinutes: 60 }] },
    },
  }
  return {
    model: 'jev-1.13.0',
    state,
    questions: { [vetoQuestionId('BTC')]: { type: 'noul', instructions: 'Is there a confound?', criteria: { true: 'yes', false: 'no' } } },
    ...overrides,
  }
}

Deno.test('projectJevRequestForAsset: basic slice — model, evaluatedAt, news, and the asked question all carried through verbatim', () => {
  const projection = projectJevRequestForAsset(rawRequest(), 'jev-1.13.0', 'BTC')
  assertEquals(projection.schemaVersion, JEV_REQUEST_PROJECTION_SCHEMA_VERSION)
  assertEquals(projection.asset, 'BTC')
  assertEquals(projection.modelRequested, 'jev-1.13.0')
  assertEquals(projection.modelResolved, 'jev-1.13.0')
  assertEquals(projection.evaluatedAt, '2026-10-03T12:00:00.000Z')
  assertEquals(projection.news.length, 1)
  assertEquals(projection.news[0]!.headline, 'Test')
  assertEquals(Object.keys(projection.questions), [vetoQuestionId('BTC')])
})

Deno.test('projectJevRequestForAsset: an asset with no entry in state.assets at all produces empty news, null position/opportunity, empty questions — not a throw', () => {
  const req = rawRequest()
  const projection = projectJevRequestForAsset(req, 'jev-1.13.0', 'ETH')
  assertEquals(projection.news, [])
  assertEquals(projection.position, null)
  assertEquals(projection.opportunity, null)
  assertEquals(projection.questions, {})
})

Deno.test('projectJevRequestForAsset: position and opportunity pass through when present', () => {
  const req = rawRequest({
    state: {
      evaluatedAt: '2026-10-03T12:00:00.000Z',
      assets: { BTC: { news: [], position: positionSnapshot(), opportunity: opportunitySnapshot() } },
    },
  })
  const projection = projectJevRequestForAsset(req, 'jev-1.13.0', 'BTC')
  assertEquals(projection.position?.entryPrice, 100)
  assertEquals(projection.opportunity?.atrTargetDistancePct, 0.02)
})

Deno.test('projectJevRequestForAsset: portfolio fields are null for a pure veto-only cycle (navUsd undefined on the shared state)', () => {
  const projection = projectJevRequestForAsset(rawRequest(), 'jev-1.13.0', 'BTC')
  assertEquals(projection.portfolio, null)
})

Deno.test('projectJevRequestForAsset: portfolio fields carried through when present (a management-candidate cycle)', () => {
  const req = rawRequest({
    state: {
      evaluatedAt: '2026-10-03T12:00:00.000Z',
      navUsd: 10_000,
      availableCashUsd: 8_000,
      totalExposurePct: 0.2,
      assets: { BTC: { news: [] } },
    },
  })
  const projection = projectJevRequestForAsset(req, 'jev-1.13.0', 'BTC')
  assertEquals(projection.portfolio, { navUsd: 10_000, availableCashUsd: 8_000, totalExposurePct: 0.2 })
})

Deno.test('projectJevRequestForAsset: only this asset\'s own question ids are captured — not every question id in the batch', () => {
  const req = rawRequest({
    questions: {
      [vetoQuestionId('BTC')]: { type: 'noul', instructions: 'btc veto', criteria: { true: 'y', false: 'n' } },
      [managementActionQuestionId('BTC')]: { type: 'choice', instructions: 'btc action', criteria: { HOLD: 'x' } },
      [addConvictionQuestionId('BTC')]: { type: 'score', instructions: 'btc add', criteria: ['a'] },
    },
  })
  const projection = projectJevRequestForAsset(req, 'jev-1.13.0', 'BTC')
  assertEquals(
    Object.keys(projection.questions).sort(),
    [vetoQuestionId('BTC'), managementActionQuestionId('BTC'), addConvictionQuestionId('BTC')].sort(),
  )
})

Deno.test('projectJevRequestForAsset: cross-asset isolation — BTC\'s projection never includes ETH\'s question ids or news, even though both live in the SAME shared state/questions objects', () => {
  const req: JevRawRequest = {
    model: 'jev-1.13.0',
    state: {
      evaluatedAt: '2026-10-03T12:00:00.000Z',
      assets: {
        BTC: { news: [{ source: 'A', headline: 'BTC headline', summary: null, publishedAt: '2026-10-03T11:00:00.000Z', ageMinutes: 60 }] },
        ETH: { news: [{ source: 'B', headline: 'ETH headline', summary: null, publishedAt: '2026-10-03T11:00:00.000Z', ageMinutes: 60 }] },
      },
    },
    questions: {
      [vetoQuestionId('BTC')]: { type: 'noul', instructions: 'btc veto', criteria: { true: 'y', false: 'n' } },
      [vetoQuestionId('ETH')]: { type: 'noul', instructions: 'eth veto', criteria: { true: 'y', false: 'n' } },
      [entryQualityQuestionId('ETH')]: { type: 'choice', instructions: 'eth entry', criteria: { ENTER: 'x', SKIP: 'y' } },
      [expectedMoveQuestionId('ETH')]: { type: 'score', instructions: 'eth move', criteria: ['a'] },
    },
  }
  const btcProjection = projectJevRequestForAsset(req, 'jev-1.13.0', 'BTC')
  assertEquals(btcProjection.news[0]!.headline, 'BTC headline')
  assertEquals(Object.keys(btcProjection.questions), [vetoQuestionId('BTC')])
  // The decisive assertion: nothing ETH-shaped leaked into BTC's slice.
  assertEquals(vetoQuestionId('ETH') in btcProjection.questions, false)
  assertEquals(entryQualityQuestionId('ETH') in btcProjection.questions, false)
  assertEquals(expectedMoveQuestionId('ETH') in btcProjection.questions, false)
})

Deno.test('projectJevRequestForAsset: all four question-family id builders are checked — remaining_upside, failure_risk, failure_mode all captured when present', () => {
  const req = rawRequest({
    questions: {
      [remainingUpsideQuestionId('BTC')]: { type: 'score', instructions: 'upside', criteria: ['a'] },
      [failureRiskQuestionId('BTC')]: { type: 'choice', instructions: 'risk', criteria: { LOW: 'x' } },
      [failureModeQuestionId('BTC')]: { type: 'choice', instructions: 'mode', criteria: { NONE: 'x' } },
    },
  })
  const projection = projectJevRequestForAsset(req, 'jev-1.13.0', 'BTC')
  assertEquals(
    Object.keys(projection.questions).sort(),
    [remainingUpsideQuestionId('BTC'), failureRiskQuestionId('BTC'), failureModeQuestionId('BTC')].sort(),
  )
})

Deno.test('projectJevRequestForAsset: modelResolved can legitimately differ from modelRequested (an alias resolving to a concrete pinned version) — both are kept, never collapsed to one', () => {
  const projection = projectJevRequestForAsset(rawRequest({ model: 'jev-latest' }), 'jev-1.13.0', 'BTC')
  assertEquals(projection.modelRequested, 'jev-latest')
  assertEquals(projection.modelResolved, 'jev-1.13.0')
})

Deno.test('projectJevRequestForAsset: throws on a malformed envelope rather than silently persisting a bad record — a genuine shape failure, matching schema.ts\'s own expectNoul/expectChoice/expectScore discipline', () => {
  const malformed = { model: 'jev-1.13.0', state: { evaluatedAt: '', assets: {} }, questions: {} } as unknown as JevRawRequest
  // evaluatedAt is an empty string — fails the envelope's own min(1) check,
  // simulating the class of defect this parse exists to catch (a caller
  // passing a genuinely broken rawRequest, not a hypothetical).
  assertThrows(() => projectJevRequestForAsset(malformed, 'jev-1.13.0', 'BTC'))
})
