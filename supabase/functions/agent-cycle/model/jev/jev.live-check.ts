// Manual live smoke test — NOT part of `deno test` (real API call, real
// quota usage). Run by hand:
//
//   deno run --allow-net --allow-env --env-file=.env supabase/functions/agent-cycle/model/jev/jev.live-check.ts
//
// This is Phase 2 Stage A of the Gemini -> Jev migration plan: it
// validates QUESTION SEMANTICS AND FAILURE BEHAVIOR against the real
// TypeSafe API — not threshold optimality, and it is explicitly NOT a
// Jev-vs-Gemini comparison (Gemini has been removed entirely). The
// adversarial pair below mirrors the deleted call-model.live-check.ts's
// own convention: one candidate with ordinary, non-material news (expect
// a low noul / ALLOW), one with a genuine named exogenous event (expect a
// high noul / VETO). If the ordering comes out wrong, the question
// wording in model/jev/question.ts is wrong — no threshold can rescue
// that, which is exactly why this check exists before any threshold
// discussion happens.
//
// Read-only with respect to trading state: this script never touches
// agent_runs, positions, trades, or the broker (plan Phase 2 item 14).

import { requestVetoDecisions } from './provider.ts'
import type { VetoCandidateInput } from '../payload.ts'

const candidates: VetoCandidateInput[] = [
  {
    asset: 'BTC',
    news: [
      { id: '11111111-1111-1111-1111-111111111111', source: 'Cointelegraph', headline: 'Bitcoin ETF sees third straight day of inflows', summary: 'Spot ETFs recorded $210M in net inflows.', publishedAt: new Date(Date.now() - 3_600_000).toISOString(), ageMinutes: 60 },
    ],
  },
  {
    asset: 'ETH',
    news: [
      { id: '22222222-2222-2222-2222-222222222222', source: 'The Block', headline: 'Major exchange discloses $400M exploit, withdrawals paused', summary: 'The exchange confirmed a smart contract exploit drained a significant share of user funds; withdrawals have been halted pending investigation.', publishedAt: new Date(Date.now() - 1_800_000).toISOString(), ageMinutes: 30 },
    ],
  },
]

const apiKey = Deno.env.get('TYPESAFE_API_KEY') ?? ''
if (!apiKey) {
  console.error('TYPESAFE_API_KEY is not set (expected in .env or the environment) — cannot run a live check.')
  Deno.exit(1)
}

console.log('Calling Jev with a realistic 2-candidate veto payload (BTC: ordinary news, ETH: genuine exploit headline)...')
const start = performance.now()
const result = await requestVetoDecisions(candidates, apiKey)
const elapsedMs = Math.round(performance.now() - start)

console.log(`\nmodelVersion: ${result.modelVersion}`)
console.log(`elapsed: ${elapsedMs}ms`)
console.log(`\nOutcomes:`)
for (const outcome of result.outcomes) {
  console.log(`  ${outcome.asset}: noul=${outcome.noul.toFixed(3)} veto=${outcome.veto}`)
}

const btc = result.outcomes.find((o) => o.asset === 'BTC')
const eth = result.outcomes.find((o) => o.asset === 'ETH')
if (btc?.veto) {
  console.warn('\nWARNING: BTC candidate (ETF-inflow news, not exogenous) was vetoed — expected veto=false. Question wording may be over-triggering.')
}
if (eth && !eth.veto) {
  console.warn('\nWARNING: ETH candidate (a genuine exchange-hack headline) was NOT vetoed — expected veto=true. Question wording may be under-triggering on real exogenous events.')
}
if (btc && eth && btc.noul >= eth.noul) {
  console.warn('\nWARNING: expected the exploit headline (ETH) to score a strictly higher noul than the ordinary news (BTC) — the ordering is the real signal this check exists to catch, independent of where the threshold ends up.')
}

console.log('\nOK — real Jev response parsed and validated end-to-end.')
console.log('Raw request/response (for manual inspection, not asserted):')
console.log(JSON.stringify({ request: result.rawRequest, response: result.rawResponse }, null, 2))
