import { assertEquals } from 'jsr:@std/assert@1'
import { requestPortfolioDecisions } from './provider.ts'
import type { EntryOpportunityInput } from './entry-question.ts'
import type { VetoCandidateInput } from '../payload.ts'

// Aggressive strategy — requestPortfolioDecisions' entryOpportunities
// extension. Separate file from provider.test.ts specifically so the
// existing Balanced/Phase-2 suite (18 tests, all passing unmodified after
// this extension) stays a clean, untouched regression signal.

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

function vetoCandidate(asset: 'BTC' | 'ETH' = 'BTC'): VetoCandidateInput {
  return { asset, direction: 'long', news: [{ id: 'n1', source: 'Test', headline: 'Test headline', summary: null, publishedAt: '2026-09-23T00:00:00.000Z', ageMinutes: 5 }] }
}

function fetchReturning(answers: Record<string, unknown>, model = 'jev-1.13.0'): typeof fetch {
  return (() => Promise.resolve(new Response(JSON.stringify({ model, answers }), { status: 200, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch
}

// Strategy V4 (2026-10-02, plan §5.1c) — every opportunity now also asks
// failure_risk/failure_mode (adversarial-question.ts), so any mocked
// response for a call that passes entryOpportunities must answer these
// two alongside entry_quality/expected_move, or parseJevResponse's exact-
// cardinality check throws. Centralized here so each test only states
// what it cares about.
function adversarialAnswersFor(assetTag: string) {
  return {
    [`${assetTag}_failure_risk`]: { type: 'choice', choice: 'LOW', confidence: 0.6, probabilities: { LOW: 0.6, MEDIUM: 0.3, HIGH: 0.1 } },
    [`${assetTag}_failure_mode`]: { type: 'choice', choice: 'NONE', confidence: 0.5, probabilities: { MOMENTUM_EXHAUSTION: 0.1, COUNTER_TREND_PRESSURE: 0.1, WEAK_VOLUME_CONFIRMATION: 0.1, RANGE_COMPRESSION: 0.1, STRUCTURE_BREAK: 0.1, NONE: 0.5 } },
  }
}

Deno.test('requestPortfolioDecisions: with no entryOpportunities passed, entryOutcomes and adversarialOutcomes are both empty and behavior is identical to before this extension', async () => {
  const fetchImpl = fetchReturning({ veto_btc: { type: 'noul', noul: 0.1 } })
  const result = await requestPortfolioDecisions([vetoCandidate()], [], 10000, 5000, 0.2, 'key', fetchImpl)
  assertEquals(result.entryOutcomes, [])
  assertEquals(result.adversarialOutcomes, [])
})

Deno.test('requestPortfolioDecisions: an entry opportunity adds entry_quality/expected_move/failure_risk/failure_mode questions alongside the unchanged veto question', async () => {
  let seenQuestions: string[] = []
  const fetchImpl = ((_url: string, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string)
    seenQuestions = Object.keys(body.questions)
    return Promise.resolve(
      new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            veto_btc: { type: 'noul', noul: 0.1 },
            btc_entry_quality: { type: 'choice', choice: 'ENTER', confidence: 0.8, probabilities: { ENTER: 0.8, SKIP: 0.2 } },
            btc_expected_move: { type: 'score', score: 2, confidence: 0.6, probabilities: { 0: 0.1, 1: 0.1, 2: 0.6, 3: 0.2 }, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd' } },
            ...adversarialAnswersFor('btc'),
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
  }) as unknown as typeof fetch

  await requestPortfolioDecisions([vetoCandidate()], [], 10000, 5000, 0.2, 'key', fetchImpl, {}, [opportunity()])
  assertEquals(seenQuestions.sort(), ['btc_entry_quality', 'btc_expected_move', 'btc_failure_mode', 'btc_failure_risk', 'veto_btc'])
})

Deno.test('requestPortfolioDecisions: still exactly ONE HTTP request even with veto + management + entry + adversarial all combined', async () => {
  let calls = 0
  const fetchImpl = (() => {
    calls++
    return Promise.resolve(
      new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            veto_eth: { type: 'noul', noul: 0.1 },
            btc_entry_quality: { type: 'choice', choice: 'ENTER', confidence: 0.8, probabilities: { ENTER: 0.8, SKIP: 0.2 } },
            btc_expected_move: { type: 'score', score: 1, confidence: 0.5, probabilities: { 0: 0.2, 1: 0.5, 2: 0.2, 3: 0.1 }, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd' } },
            ...adversarialAnswersFor('btc'),
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
  }) as unknown as typeof fetch

  await requestPortfolioDecisions([vetoCandidate('ETH')], [], 10000, 5000, 0.2, 'key', fetchImpl, {}, [opportunity({ asset: 'BTC' })])
  assertEquals(calls, 1)
})

Deno.test('requestPortfolioDecisions: ENTER maps to enter=true, expectedMovePct comes from the pre-registered score table, never a raw model number', async () => {
  const fetchImpl = fetchReturning({
    veto_btc: { type: 'noul', noul: 0.1 },
    btc_entry_quality: { type: 'choice', choice: 'ENTER', confidence: 0.9, probabilities: { ENTER: 0.9, SKIP: 0.1 } },
    btc_expected_move: { type: 'score', score: 3, confidence: 0.7, probabilities: { 0: 0, 1: 0, 2: 0.3, 3: 0.7 }, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd' } },
    ...adversarialAnswersFor('btc'),
  })
  const result = await requestPortfolioDecisions([vetoCandidate()], [], 10000, 5000, 0.2, 'key', fetchImpl, {}, [opportunity()])
  assertEquals(result.entryOutcomes.length, 1)
  assertEquals(result.entryOutcomes[0]!.enter, true)
  assertEquals(result.entryOutcomes[0]!.expectedMovePct, 0.020) // level 3 in EXPECTED_MOVE_PCT_BY_SCORE_LEVEL
})

Deno.test('requestPortfolioDecisions: SKIP maps to enter=false', async () => {
  const fetchImpl = fetchReturning({
    veto_btc: { type: 'noul', noul: 0.1 },
    btc_entry_quality: { type: 'choice', choice: 'SKIP', confidence: 0.9, probabilities: { ENTER: 0.1, SKIP: 0.9 } },
    btc_expected_move: { type: 'score', score: 0, confidence: 0.5, probabilities: { 0: 1, 1: 0, 2: 0, 3: 0 }, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd' } },
    ...adversarialAnswersFor('btc'),
  })
  const result = await requestPortfolioDecisions([vetoCandidate()], [], 10000, 5000, 0.2, 'key', fetchImpl, {}, [opportunity()])
  assertEquals(result.entryOutcomes[0]!.enter, false)
})

Deno.test('requestPortfolioDecisions: an unrecognized entry_quality value is a shape failure, not silently coerced to SKIP or ENTER', async () => {
  const { assertRejects } = await import('jsr:@std/assert@1')
  const fetchImpl = fetchReturning({
    veto_btc: { type: 'noul', noul: 0.1 },
    btc_entry_quality: { type: 'choice', choice: 'MAYBE', confidence: 0.5, probabilities: { MAYBE: 1 } },
    btc_expected_move: { type: 'score', score: 1, confidence: 0.5, probabilities: { 0: 0, 1: 1, 2: 0, 3: 0 }, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd' } },
    ...adversarialAnswersFor('btc'),
  })
  await assertRejects(() => requestPortfolioDecisions([vetoCandidate()], [], 10000, 5000, 0.2, 'key', fetchImpl, {}, [opportunity()]))
})

Deno.test('requestPortfolioDecisions: the veto outcome for the same asset is completely independent of the entry_quality answer — both are reported, neither is suppressed here', async () => {
  // The veto=true / entry=ENTER combination looks contradictory on its
  // face, but this function's own job is only to REPORT both raw
  // outcomes; strategy/registry.ts is where "either can only remove, not
  // grant" is actually enforced (mirroring apply-veto.ts's containment).
  const fetchImpl = fetchReturning({
    veto_btc: { type: 'noul', noul: 0.95 }, // vetoed
    btc_entry_quality: { type: 'choice', choice: 'ENTER', confidence: 0.9, probabilities: { ENTER: 0.9, SKIP: 0.1 } },
    btc_expected_move: { type: 'score', score: 2, confidence: 0.6, probabilities: { 0: 0, 1: 0, 2: 1, 3: 0 }, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd' } },
    ...adversarialAnswersFor('btc'),
  })
  const result = await requestPortfolioDecisions([vetoCandidate()], [], 10000, 5000, 0.2, 'key', fetchImpl, {}, [opportunity()])
  assertEquals(result.vetoOutcomes[0]!.veto, true)
  assertEquals(result.entryOutcomes[0]!.enter, true)
})

// --- Strategy V4 (2026-10-02, plan §5.1c) — adversarial critique is advisory, never removes a candidate here ---

Deno.test('requestPortfolioDecisions: failure_risk/failure_mode are reported on adversarialOutcomes with their full distributions, independent of entry_quality/veto', async () => {
  const fetchImpl = fetchReturning({
    veto_btc: { type: 'noul', noul: 0.1 },
    btc_entry_quality: { type: 'choice', choice: 'ENTER', confidence: 0.9, probabilities: { ENTER: 0.9, SKIP: 0.1 } },
    btc_expected_move: { type: 'score', score: 2, confidence: 0.6, probabilities: { 0: 0, 1: 0, 2: 1, 3: 0 }, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd' } },
    btc_failure_risk: { type: 'choice', choice: 'HIGH', confidence: 0.77, probabilities: { LOW: 0.05, MEDIUM: 0.18, HIGH: 0.77 } },
    btc_failure_mode: { type: 'choice', choice: 'MOMENTUM_EXHAUSTION', confidence: 0.6, probabilities: { MOMENTUM_EXHAUSTION: 0.46, COUNTER_TREND_PRESSURE: 0.31, WEAK_VOLUME_CONFIRMATION: 0.12, RANGE_COMPRESSION: 0.06, STRUCTURE_BREAK: 0.02, NONE: 0.03 } },
  })
  const result = await requestPortfolioDecisions([vetoCandidate()], [], 10000, 5000, 0.2, 'key', fetchImpl, {}, [opportunity()])
  assertEquals(result.adversarialOutcomes.length, 1)
  const outcome = result.adversarialOutcomes[0]!
  assertEquals(outcome.failureRisk, 'HIGH')
  assertEquals(outcome.failureRiskConfidence, 0.77)
  assertEquals(outcome.failureRiskDistribution, { LOW: 0.05, MEDIUM: 0.18, HIGH: 0.77 })
  assertEquals(outcome.failureMode, 'MOMENTUM_EXHAUSTION')
  assertEquals(outcome.failureModeDistribution.MOMENTUM_EXHAUSTION, 0.46)
  // entry_quality still ENTER regardless of a HIGH failure_risk — neither can remove the other.
  assertEquals(result.entryOutcomes[0]!.enter, true)
})

Deno.test('requestPortfolioDecisions: an unrecognized failure_mode value is a shape failure, never silently coerced to NONE', async () => {
  const { assertRejects } = await import('jsr:@std/assert@1')
  const fetchImpl = fetchReturning({
    veto_btc: { type: 'noul', noul: 0.1 },
    btc_entry_quality: { type: 'choice', choice: 'ENTER', confidence: 0.9, probabilities: { ENTER: 0.9, SKIP: 0.1 } },
    btc_expected_move: { type: 'score', score: 2, confidence: 0.6, probabilities: { 0: 0, 1: 0, 2: 1, 3: 0 }, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd' } },
    btc_failure_risk: { type: 'choice', choice: 'LOW', confidence: 0.5, probabilities: { LOW: 1, MEDIUM: 0, HIGH: 0 } },
    btc_failure_mode: { type: 'choice', choice: 'SOMETHING_ELSE', confidence: 0.5, probabilities: { SOMETHING_ELSE: 1 } },
  })
  await assertRejects(() => requestPortfolioDecisions([vetoCandidate()], [], 10000, 5000, 0.2, 'key', fetchImpl, {}, [opportunity()]))
})

Deno.test('requestPortfolioDecisions: an unrecognized failure_risk value is a shape failure', async () => {
  const { assertRejects } = await import('jsr:@std/assert@1')
  const fetchImpl = fetchReturning({
    veto_btc: { type: 'noul', noul: 0.1 },
    btc_entry_quality: { type: 'choice', choice: 'ENTER', confidence: 0.9, probabilities: { ENTER: 0.9, SKIP: 0.1 } },
    btc_expected_move: { type: 'score', score: 2, confidence: 0.6, probabilities: { 0: 0, 1: 0, 2: 1, 3: 0 }, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd' } },
    btc_failure_risk: { type: 'choice', choice: 'EXTREME', confidence: 0.5, probabilities: { EXTREME: 1 } },
    ...{ btc_failure_mode: adversarialAnswersFor('btc').btc_failure_mode },
  })
  await assertRejects(() => requestPortfolioDecisions([vetoCandidate()], [], 10000, 5000, 0.2, 'key', fetchImpl, {}, [opportunity()]))
})

Deno.test('requestPortfolioDecisions: a HIGH failure_risk + SKIP entry_quality still reports both — neither this function nor the caller treats either as blocking here', async () => {
  const fetchImpl = fetchReturning({
    veto_btc: { type: 'noul', noul: 0.1 },
    btc_entry_quality: { type: 'choice', choice: 'SKIP', confidence: 0.6, probabilities: { ENTER: 0.4, SKIP: 0.6 } },
    btc_expected_move: { type: 'score', score: 0, confidence: 0.5, probabilities: { 0: 1, 1: 0, 2: 0, 3: 0 }, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd' } },
    btc_failure_risk: { type: 'choice', choice: 'HIGH', confidence: 0.8, probabilities: { LOW: 0.1, MEDIUM: 0.1, HIGH: 0.8 } },
    btc_failure_mode: { type: 'choice', choice: 'STRUCTURE_BREAK', confidence: 0.7, probabilities: { MOMENTUM_EXHAUSTION: 0.05, COUNTER_TREND_PRESSURE: 0.05, WEAK_VOLUME_CONFIRMATION: 0.05, RANGE_COMPRESSION: 0.05, STRUCTURE_BREAK: 0.7, NONE: 0.1 } },
  })
  const result = await requestPortfolioDecisions([vetoCandidate()], [], 10000, 5000, 0.2, 'key', fetchImpl, {}, [opportunity()])
  assertEquals(result.entryOutcomes[0]!.enter, false)
  assertEquals(result.adversarialOutcomes[0]!.failureRisk, 'HIGH')
})
