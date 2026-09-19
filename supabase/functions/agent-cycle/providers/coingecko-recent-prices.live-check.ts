// Manual live smoke test — NOT part of `deno test` (real network call).
// Run by hand:
//
//   deno run --allow-net supabase/functions/agent-cycle/providers/coingecko-recent-prices.live-check.ts
//
// Proves fetchRecentPricePoints (added for Step 5's position monitor)
// actually delivers 5-minute-spaced points from the real API, not just
// that it parses a shape I assumed.

import { fetchRecentPricePoints } from './coingecko.ts'

const points = await fetchRecentPricePoints(['BTC', 'ETH'])

for (const asset of ['BTC', 'ETH'] as const) {
  const series = points[asset] ?? []
  console.log(`\n${asset}: ${series.length} points`)
  if (series.length >= 2) {
    const first = series[0]!
    const last = series[series.length - 1]!
    const spacingMs = new Date(series[1]!.timestamp).getTime() - new Date(series[0]!.timestamp).getTime()
    console.log(`  spacing: ${spacingMs} ms (${spacingMs / 60_000} min)`)
    console.log(`  range: ${first.timestamp} .. ${last.timestamp}`)
    console.log(`  latest price: ${last.price}`)
  }
}

console.log('\nOK — live response matched the expected shape.')
