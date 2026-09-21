// Manual live smoke test — NOT part of `deno test` (real API call, real
// quota usage). Run by hand:
//
//   deno run --allow-net --allow-env --env-file=.env supabase/functions/agent-cycle/model/call-model.live-check.ts
//
// Proves the full veto seam against the real Gemini API with a realistic
// two-candidate payload (one with confirming/no news, one with a genuine
// exogenous event that a correctly-behaving veto should catch) — not just
// that it parses a shape assumed from docs: the exact
// GEMINI_VETO_RESPONSE_SCHEMA, VETO_SYSTEM_PROMPT, and parseVetoOutput's
// strict mapping all have to actually agree for this to succeed.

import { callModel } from './call-model.ts'
import type { VetoCallPayload } from './payload.ts'

const payload: VetoCallPayload = {
  candidates: [
    {
      asset: 'BTC',
      regime: { dailyClose: 82_400, dailyMa: 78_900 },
      stopLossPct: 0.025,
      takeProfitPct: 0.15,
      news: [
        { id: '11111111-1111-1111-1111-111111111111', source: 'Cointelegraph', headline: 'Bitcoin ETF sees third straight day of inflows', summary: 'Spot ETFs recorded $210M in net inflows.', publishedAt: new Date(Date.now() - 3_600_000).toISOString(), ageMinutes: 60 },
      ],
    },
    {
      asset: 'ETH',
      regime: { dailyClose: 2_950, dailyMa: 2_820 },
      stopLossPct: 0.03,
      takeProfitPct: 0.18,
      news: [
        { id: '22222222-2222-2222-2222-222222222222', source: 'The Block', headline: 'Major exchange discloses $400M exploit, withdrawals paused', summary: 'The exchange confirmed a smart contract exploit drained a significant share of user funds; withdrawals have been halted pending investigation.', publishedAt: new Date(Date.now() - 1_800_000).toISOString(), ageMinutes: 30 },
      ],
    },
  ],
}

const apiKeys = [Deno.env.get('GEMINI_API_KEY_1')].filter((k): k is string => !!k)

console.log(`Calling Gemini with a realistic 2-candidate veto payload (${apiKeys.length} key(s) configured)...`)
const result = await callModel(payload, apiKeys)

console.log(`\nkeyIndexUsed: ${result.keyIndexUsed}`)
console.log(`modelVersion: ${result.modelVersion}`)
console.log(`promptVersion: ${result.promptVersion}`)
console.log(`\nVerdicts:`)
for (const v of result.verdicts) {
  console.log(`\n  ${v.asset}: veto=${v.veto}`)
  console.log(`    rationale: ${v.rationale}`)
}

const btc = result.verdicts.find((v) => v.asset === 'BTC')
const eth = result.verdicts.find((v) => v.asset === 'ETH')
if (btc?.veto) {
  console.warn('\nWARNING: BTC candidate (ETF-inflow news, not exogenous) was vetoed — expected veto=false. Prompt may be over-triggering.')
}
if (eth && !eth.veto) {
  console.warn('\nWARNING: ETH candidate (a genuine exchange-hack headline) was NOT vetoed — expected veto=true. Prompt may be under-triggering on real exogenous events.')
}

console.log('\nOK — real Gemini response parsed and validated end-to-end.')
