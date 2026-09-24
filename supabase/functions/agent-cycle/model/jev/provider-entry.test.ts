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
  return { asset, news: [{ id: 'n1', source: 'Test', headline: 'Test headline', summary: null, publishedAt: '2026-09-23T00:00:00.000Z', ageMinutes: 5 }] }
}

function fetchReturning(answers: Record<string, unknown>, model = 'jev-1.13.0'): typeof fetch {
  return (() => Promise.resolve(new Response(JSON.stringify({ model, answers }), { status: 200, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch
}

Deno.test('requestPortfolioDecisions: with no entryOpportunities passed, entryOutcomes is empty and behavior is identical to before this extension', async () => {
  const fetchImpl = fetchReturning({ veto_btc: { type: 'noul', noul: 0.1 } })
  const result = await requestPortfolioDecisions([vetoCandidate()], [], 10000, 5000, 0.2, 'key', fetchImpl)
  assertEquals(result.entryOutcomes, [])
})

Deno.test('requestPortfolioDecisions: an entry opportunity adds entry_quality/expected_move questions alongside the unchanged veto question', async () => {
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
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
  }) as unknown as typeof fetch

  await requestPortfolioDecisions([vetoCandidate()], [], 10000, 5000, 0.2, 'key', fetchImpl, {}, [opportunity()])
  assertEquals(seenQuestions.sort(), ['btc_entry_quality', 'btc_expected_move', 'veto_btc'])
})

Deno.test('requestPortfolioDecisions: still exactly ONE HTTP request even with veto + management + entry all combined', async () => {
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
  })
  const result = await requestPortfolioDecisions([vetoCandidate()], [], 10000, 5000, 0.2, 'key', fetchImpl, {}, [opportunity()])
  assertEquals(result.vetoOutcomes[0]!.veto, true)
  assertEquals(result.entryOutcomes[0]!.enter, true)
})
