// Manual live smoke test — NOT part of `deno test` (real API call, real
// quota usage). Run by hand:
//
//   deno run --allow-net --allow-env --env-file=.env supabase/functions/agent-cycle/model/call-model.live-check.ts
//
// Proves the full seam against the real Gemini API with a realistic
// two-asset payload (one FLAT, one with an open LONG) — not just that it
// parses a shape assumed from docs: the exact GEMINI_RESPONSE_SCHEMA
// (nullable fields, enums), systemInstruction, and parseModelOutput's
// strict mapping all have to actually agree for this to succeed.

import { callModel } from './call-model.ts'
import type { ModelCallPayload } from './payload.ts'

const payload: ModelCallPayload = {
  portfolio: {
    cash: 6_500,
    nav: 10_200,
    constraints: { minConfidence: 0.65, minStopLossPct: 0.005, maxStopLossPct: 0.15, minTakeProfitPct: 0.005, maxTakeProfitPct: 0.5 },
  },
  assets: [
    {
      asset: 'BTC',
      state: 'FLAT',
      market: {
        price: 81_200,
        change1hPct: 0.2,
        change24hPct: -1.8,
        change7dPct: 4.1,
        indicators: { rsi14: 58, ema20: 80_500, ema50: 78_900, macdHistogram: 120, atrPct: 2.4, volumeRatio: 1.15, distanceFromSevenDayHighPct: -3.2, distanceFromSevenDayLowPct: 9.6 },
        recentCloses: Array.from({ length: 6 }, (_, i) => ({ timestamp: new Date(Date.now() - (5 - i) * 3_600_000).toISOString(), close: 80_000 + i * 200 })),
      },
      news: [
        { id: '11111111-1111-1111-1111-111111111111', source: 'Cointelegraph', headline: 'Bitcoin ETF sees third straight day of inflows', summary: 'Spot ETFs recorded $210M in net inflows.', publishedAt: new Date(Date.now() - 3_600_000).toISOString(), ageMinutes: 60 },
      ],
      position: null,
      recentDecisions: [
        { decidedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), action: 'HOLD', confidence: 0.4, invalidation: [] },
      ],
      blockedDirections: [],
    },
    {
      asset: 'ETH',
      state: 'LONG',
      market: {
        price: 2_950,
        change1hPct: -0.3,
        change24hPct: 2.6,
        change7dPct: -1.1,
        indicators: { rsi14: 62, ema20: 2_900, ema50: 2_850, macdHistogram: 8, atrPct: 3.1, volumeRatio: 0.9, distanceFromSevenDayHighPct: -1.5, distanceFromSevenDayLowPct: 6.2 },
        recentCloses: Array.from({ length: 6 }, (_, i) => ({ timestamp: new Date(Date.now() - (5 - i) * 3_600_000).toISOString(), close: 2_880 + i * 15 })),
      },
      news: [],
      position: { direction: 'long', entryPrice: 2_820, stopLossPrice: 2_700, takeProfitPrice: 3_050, unrealizedPnlPct: 4.6, heldHours: 18, openInvalidation: [{ text: 'ETH closes below the 50-day EMA on daily timeframe' }] },
      recentDecisions: [
        { decidedAt: new Date(Date.now() - 18 * 3_600_000).toISOString(), action: 'OPEN_LONG', confidence: 0.71, invalidation: [{ text: 'ETH closes below the 50-day EMA on daily timeframe' }] },
      ],
      blockedDirections: ['short'],
    },
  ],
}

const apiKeys = [Deno.env.get('GEMINI_API_KEY_1'), Deno.env.get('GEMINI_API_KEY_2'), Deno.env.get('GEMINI_API_KEY_3')].filter((k): k is string => !!k)

console.log(`Calling Gemini with a realistic 2-asset payload (${apiKeys.length} key(s) configured)...`)
const result = await callModel(payload, apiKeys)

console.log(`\nkeyIndexUsed: ${result.keyIndexUsed}`)
console.log(`modelVersion: ${result.modelVersion}`)
console.log(`promptVersion: ${result.promptVersion}`)
console.log(`\nDecisions:`)
for (const d of result.decisions) {
  console.log(`\n  ${d.asset}: ${d.action} (confidence ${d.confidence})`)
  if (d.action === 'OPEN_LONG' || d.action === 'OPEN_SHORT') {
    console.log(`    stopLossPct=${d.stopLossPct} takeProfitPct=${d.takeProfitPct}`)
  }
  console.log(`    reasons: ${d.reasons.map((r) => `[${r.type}] ${r.text}`).join(' | ')}`)
  console.log(`    invalidation: ${d.invalidation.map((i) => i.text).join(' | ') || '(none)'}`)
}

console.log('\nOK — real Gemini response parsed and validated end-to-end.')
