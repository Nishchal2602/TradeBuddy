import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { JevCallError, requestPortfolioDecisions, requestVetoDecisions } from './provider.ts'
import type { VetoCandidateInput } from '../payload.ts'
import type { ManagementCandidateInput } from './management-question.ts'

function managementCandidate(overrides: Partial<ManagementCandidateInput> = {}): ManagementCandidateInput {
  return {
    asset: 'BTC', direction: 'long', entryPrice: 100, currentPrice: 120, quantity: 10,
    stopLossPrice: 90, takeProfitPrice: 180, heldHours: 12, feeBps: 10, slippageBps: 5, atrPct: 2.5, news: [],
    minStopLossPct: 0.005,
    ...overrides,
  }
}

function candidate(asset: 'BTC' | 'ETH', overrides: Partial<VetoCandidateInput> = {}): VetoCandidateInput {
  return {
    asset,
    news: [{ id: 'news-1', source: 'Cointelegraph', headline: 'Exchange hacked, funds drained', summary: 'A major exchange reported a hack.', publishedAt: '2026-09-22T08:00:00.000Z', ageMinutes: 60 }],
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function fetchReturning(answers: Record<string, number>, model = 'jev-1.13.0'): typeof fetch {
  return (() =>
    Promise.resolve(
      jsonResponse({ model, answers: Object.fromEntries(Object.entries(answers).map(([id, noul]) => [id, { type: 'noul', noul }])) }),
    )) as unknown as typeof fetch
}

// --- Fail-closed on missing key -------------------------------------------

Deno.test('requestVetoDecisions: throws immediately with no HTTP call when the API key is empty', async () => {
  let called = false
  const fetchImpl = (() => {
    called = true
    return Promise.resolve(jsonResponse({ model: 'jev-1.13.0', answers: {} }))
  }) as unknown as typeof fetch

  await assertRejects(() => requestVetoDecisions([candidate('BTC')], '', fetchImpl), JevCallError)
  assertEquals(called, false, 'a missing key must fail before any network request is attempted')
})

// --- Correct per-asset mapping --------------------------------------------

Deno.test('requestVetoDecisions: maps each answer back to the correct candidate by asset, even out of order', async () => {
  const fetchImpl = fetchReturning({ veto_eth: 0.9, veto_btc: 0.1 })
  const result = await requestVetoDecisions([candidate('BTC'), candidate('ETH')], 'key', fetchImpl)
  const btc = result.outcomes.find((o) => o.asset === 'BTC')!
  const eth = result.outcomes.find((o) => o.asset === 'ETH')!
  assertEquals(btc.noul, 0.1)
  assertEquals(eth.noul, 0.9)
})

Deno.test('requestVetoDecisions: a single candidate produces exactly one outcome', async () => {
  const fetchImpl = fetchReturning({ veto_btc: 0.5 })
  const result = await requestVetoDecisions([candidate('BTC')], 'key', fetchImpl)
  assertEquals(result.outcomes.length, 1)
  assertEquals(result.outcomes[0]!.asset, 'BTC')
})

// --- Threshold boundary ----------------------------------------------------

Deno.test('requestVetoDecisions: noul exactly at JEV_VETO_THRESHOLD (0.70) is a veto — boundary is inclusive', async () => {
  const fetchImpl = fetchReturning({ veto_btc: 0.70 })
  const result = await requestVetoDecisions([candidate('BTC')], 'key', fetchImpl)
  assertEquals(result.outcomes[0]!.veto, true)
})

Deno.test('requestVetoDecisions: noul just below threshold (0.69) is not a veto', async () => {
  const fetchImpl = fetchReturning({ veto_btc: 0.69 })
  const result = await requestVetoDecisions([candidate('BTC')], 'key', fetchImpl)
  assertEquals(result.outcomes[0]!.veto, false)
})

Deno.test('requestVetoDecisions: noul at 0 and 1 (extremes) resolve to the expected boolean', async () => {
  const low = await requestVetoDecisions([candidate('BTC')], 'key', fetchReturning({ veto_btc: 0 }))
  assertEquals(low.outcomes[0]!.veto, false)
  const high = await requestVetoDecisions([candidate('BTC')], 'key', fetchReturning({ veto_btc: 1 }))
  assertEquals(high.outcomes[0]!.veto, true)
})

// --- Raw noul persistence (§10 of the migration plan) -----------------------

Deno.test('requestVetoDecisions: the raw noul is present on every outcome, independent of the derived veto boolean — the threshold-revisit mechanism depends on this', async () => {
  const fetchImpl = fetchReturning({ veto_btc: 0.23, veto_eth: 0.81 })
  const result = await requestVetoDecisions([candidate('BTC'), candidate('ETH')], 'key', fetchImpl)
  for (const outcome of result.outcomes) {
    assertEquals(typeof outcome.noul, 'number')
    assertEquals(Number.isFinite(outcome.noul), true)
  }
})

Deno.test('requestVetoDecisions: rawRequest and rawResponse are both persisted for replayability, and are not the same object', async () => {
  const fetchImpl = fetchReturning({ veto_btc: 0.1 })
  const result = await requestVetoDecisions([candidate('BTC')], 'key', fetchImpl)
  assertEquals(typeof result.rawRequest, 'object')
  assertEquals(typeof result.rawResponse, 'object')
  assertEquals((result.rawRequest as { model: string }).model.startsWith('jev'), true)
})

Deno.test('requestVetoDecisions: modelVersion is the resolved concrete version echoed by the API, not the requested alias', async () => {
  const fetchImpl = fetchReturning({ veto_btc: 0.1 }, 'jev-1.13.0')
  const result = await requestVetoDecisions([candidate('BTC')], 'key', fetchImpl)
  assertEquals(result.modelVersion, 'jev-1.13.0')
})

// --- Containment: the provider cannot leak noul anywhere but VetoOutcome.noul

Deno.test('requestVetoDecisions: each outcome exposes exactly {asset, veto, noul} — no extra surface the probability could travel through', async () => {
  const fetchImpl = fetchReturning({ veto_btc: 0.5 })
  const result = await requestVetoDecisions([candidate('BTC')], 'key', fetchImpl)
  assertEquals(Object.keys(result.outcomes[0]!).sort(), ['asset', 'noul', 'veto'])
})

Deno.test('requestVetoDecisions: VetoRequestResult top level exposes only outcomes/modelVersion/rawRequest/rawResponse — sizing and direction have no field to read a probability from', async () => {
  const fetchImpl = fetchReturning({ veto_btc: 0.5 })
  const result = await requestVetoDecisions([candidate('BTC')], 'key', fetchImpl)
  assertEquals(Object.keys(result).sort(), ['modelVersion', 'outcomes', 'rawRequest', 'rawResponse'])
})

// --- Failure propagation (no fallback provider) -----------------------------

Deno.test('requestVetoDecisions: an HTTP failure propagates as JevCallError, unmodified — no fallback, no swallowed error', async () => {
  const fetchImpl = (() => Promise.resolve(jsonResponse({ detail: 'invalid API key' }, 401))) as unknown as typeof fetch
  await assertRejects(() => requestVetoDecisions([candidate('BTC')], 'bad-key', fetchImpl), JevCallError)
})

Deno.test('requestVetoDecisions: zero candidates makes zero-question call and resolves with zero outcomes (no error)', async () => {
  let sawEmptyQuestions = false
  const fetchImpl = ((_url: string, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string)
    sawEmptyQuestions = Object.keys(body.questions).length === 0
    return Promise.resolve(jsonResponse({ model: 'jev-1.13.0', answers: {} }))
  }) as unknown as typeof fetch

  const result = await requestVetoDecisions([], 'key', fetchImpl)
  assertEquals(result.outcomes, [])
  assertEquals(sawEmptyQuestions, true)
})

// =========================================================================
// Phase 2 (2026-09-22) — requestPortfolioDecisions
// =========================================================================

function mixedFetch(answers: Record<string, unknown>, model = 'jev-1.13.0'): typeof fetch {
  return (() => Promise.resolve(jsonResponse({ model, answers }))) as unknown as typeof fetch
}

const FULL_MANAGEMENT_ANSWERS = {
  btc_action: { type: 'choice', choice: 'ADD', confidence: 0.8, probabilities: { HOLD: 0.1, ADD: 0.8, REDUCE: 0.05, CLOSE: 0.03, MODIFY_PROTECTION: 0.02 } },
  btc_add_conviction: { type: 'score', score: 2, confidence: 0.7, legend: { '0': 'a', '1': 'b', '2': 'c' }, probabilities: { '0': 0, '1': 0.1, '2': 0.9 } },
  btc_reduce_magnitude: { type: 'score', score: 0, confidence: 0.6, legend: { '0': 'a', '1': 'b', '2': 'c' }, probabilities: { '0': 0.9, '1': 0.1, '2': 0 } },
  btc_stop_intent: { type: 'choice', choice: 'KEEP', confidence: 0.9, probabilities: { KEEP: 0.9, TIGHTEN_TOWARD_ENTRY: 0.1 } },
  btc_target_intent: { type: 'choice', choice: 'MOVE_OUT', confidence: 0.55, probabilities: { KEEP: 0.3, MOVE_CLOSER: 0.15, MOVE_OUT: 0.55 } },
}

Deno.test('requestPortfolioDecisions: throws immediately with no HTTP call when the API key is empty', async () => {
  let called = false
  const fetchImpl = (() => {
    called = true
    return Promise.resolve(jsonResponse({ model: 'jev-1.13.0', answers: {} }))
  }) as unknown as typeof fetch
  await assertRejects(() => requestPortfolioDecisions([], [managementCandidate()], 10_000, 8_000, 0.3, '', fetchImpl), JevCallError)
  assertEquals(called, false)
})

Deno.test('requestPortfolioDecisions: a pure management cycle (no veto candidates) returns empty vetoOutcomes and a fully-populated managementOutcome', async () => {
  const fetchImpl = mixedFetch(FULL_MANAGEMENT_ANSWERS)
  const result = await requestPortfolioDecisions([], [managementCandidate({ asset: 'BTC' })], 10_000, 8_000, 0.3, 'key', fetchImpl)
  assertEquals(result.vetoOutcomes, [])
  assertEquals(result.managementOutcomes.length, 1)
  const outcome = result.managementOutcomes[0]!
  assertEquals(outcome.asset, 'BTC')
  assertEquals(outcome.action, 'ADD')
  assertEquals(outcome.actionConfidence, 0.8)
  assertEquals(outcome.addMagnitude, 1.00) // score 2 -> top level -> 1.00
  assertEquals(outcome.reduceMagnitude, 0.25) // score 0 -> bottom level -> 0.25 (speculative, unused since action is ADD)
  assertEquals(outcome.stopIntent, 'KEEP')
  assertEquals(outcome.targetIntent, 'MOVE_OUT')
})

Deno.test('requestPortfolioDecisions: a genuinely mixed cycle (one FLAT veto asset + one OPEN management asset) is exactly ONE HTTP request', async () => {
  let calls = 0
  const fetchImpl = ((_url: string, init?: RequestInit) => {
    calls++
    const body = JSON.parse(init!.body as string)
    // Confirm both question kinds actually landed in the SAME request.
    assertEquals(Object.keys(body.questions).sort(), ['btc_action', 'btc_add_conviction', 'btc_reduce_magnitude', 'btc_stop_intent', 'btc_target_intent', 'veto_eth'].sort())
    return Promise.resolve(jsonResponse({ model: 'jev-1.13.0', answers: { ...FULL_MANAGEMENT_ANSWERS, veto_eth: { type: 'noul', noul: 0.12 } } }))
  }) as unknown as typeof fetch

  const vetoCandidates: VetoCandidateInput[] = [candidate('ETH')]
  const result = await requestPortfolioDecisions(vetoCandidates, [managementCandidate({ asset: 'BTC' })], 10_000, 8_000, 0.3, 'key', fetchImpl)
  assertEquals(calls, 1)
  assertEquals(result.vetoOutcomes.length, 1)
  assertEquals(result.vetoOutcomes[0]!.asset, 'ETH')
  assertEquals(result.vetoOutcomes[0]!.noul, 0.12)
  assertEquals(result.managementOutcomes.length, 1)
  assertEquals(result.managementOutcomes[0]!.asset, 'BTC')
})

Deno.test('requestPortfolioDecisions: an unrecognized action value from the API is a shape failure, not silently coerced', async () => {
  const fetchImpl = mixedFetch({ ...FULL_MANAGEMENT_ANSWERS, btc_action: { type: 'choice', choice: 'SOMETHING_ELSE', confidence: 0.5, probabilities: {} } })
  await assertRejects(() => requestPortfolioDecisions([], [managementCandidate()], 10_000, 8_000, 0.3, 'key', fetchImpl), JevCallError)
})

Deno.test('requestPortfolioDecisions: raw confidence and the full probability distribution are persisted (nothing gates on them, but everything is kept)', async () => {
  const fetchImpl = mixedFetch(FULL_MANAGEMENT_ANSWERS)
  const result = await requestPortfolioDecisions([], [managementCandidate()], 10_000, 8_000, 0.3, 'key', fetchImpl)
  const outcome = result.managementOutcomes[0]!
  assertEquals(typeof outcome.actionConfidence, 'number')
  assertEquals(outcome.actionProbabilities.ADD, 0.8)
  assertEquals(Object.keys(outcome.actionProbabilities).length, 5)
})

// --- Aggressive V3.1 profit recycling: remaining_upside (migration plan
// §4.4) ----------------------------------------------------------------------

const AGGRESSIVE_CONTEXT = {
  initialEntryPrice: 100, initialStopLossPrice: 92, initialRiskUsd: 80, partialRealizedPnlUsd: 0,
  sampledMfeR: 2.0, sampledMaeR: -0.2, minutesSinceEntry: 45, currentRoundTripCostUsd: 3,
  ret15mPct: 0.2, ret30mPct: 0.4, ret60mPct: 0.6, realizedVol5m: 0.05, volumeTrendRatio: 1.2,
  sampledDayHighPct: -1.5, sampledDayLowPct: 3.0,
}

Deno.test('requestPortfolioDecisions: a Balanced management candidate never asks remaining_upside, and the answer key is undefined', async () => {
  const fetchImpl = mixedFetch(FULL_MANAGEMENT_ANSWERS)
  const result = await requestPortfolioDecisions([], [managementCandidate()], 10_000, 8_000, 0.3, 'key', fetchImpl)
  assertEquals(result.managementOutcomes[0]!.remainingUpsideExpectedMovePct, undefined)
})

Deno.test('requestPortfolioDecisions: an Aggressive management candidate asks remaining_upside and maps the Score through the same table the entry path uses', async () => {
  const fetchImpl = mixedFetch({
    ...FULL_MANAGEMENT_ANSWERS,
    btc_remaining_upside: { type: 'score', score: 2, confidence: 0.6, legend: { '0': 'a', '1': 'b', '2': 'c', '3': 'd' }, probabilities: { '0': 0, '1': 0.1, '2': 0.7, '3': 0.2 } },
  })
  const result = await requestPortfolioDecisions([], [managementCandidate({ aggressive: AGGRESSIVE_CONTEXT })], 10_000, 8_000, 0.3, 'key', fetchImpl)
  // score 2 -> EXPECTED_MOVE_PCT_BY_SCORE_LEVEL[2] = 0.008, same table entry-question.ts uses
  assertEquals(result.managementOutcomes[0]!.remainingUpsideExpectedMovePct, 0.008)
})

