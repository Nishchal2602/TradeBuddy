// Manual live smoke test — NOT part of `deno test` (real network call,
// no mocking, would be flaky/rate-limit-sensitive in CI). Run by hand:
//
//   deno run --allow-net supabase/functions/agent-cycle/providers/coingecko.live-check.ts
//
// Exists so a future session can quickly re-confirm this adapter still
// matches the real CoinGecko response shape without standing up the full
// agent cycle. The fixture-based coingecko.test.ts proves the code matches
// what we believe the API returns; this proves it against the API itself.

import { CoinGeckoMarketDataProvider } from './coingecko.ts'

const provider = new CoinGeckoMarketDataProvider()
const result = await provider.getMarketData(['BTC', 'ETH'])

for (const asset of result) {
  console.log(`\n${asset.asset}`)
  console.log(`  price: $${asset.price}  (as of ${asset.dataAsOf})`)
  console.log(`  1h/24h/7d: ${asset.change1hPct}% / ${asset.change24hPct}% / ${asset.change7dPct}%`)
  console.log(`  candles: ${asset.candles.length} (4h-spaced)`)
  console.log(`  closeSeries: ${asset.closeSeries.length} (1h-spaced)`)
  console.log(`  volumeSeries: ${asset.volumeSeries.length}`)
  console.log(`  dailyCloseSeries: ${asset.dailyCloseSeries.length} (24h-spaced, closed-bar-filtered)`)
  const firstCandle = asset.candles[0]
  const lastCandle = asset.candles.at(-1)
  if (firstCandle && lastCandle) {
    console.log(`  candle range: ${firstCandle.timestamp} .. ${lastCandle.timestamp}`)
  }
}

console.log('\nOK — live response matched the NormalizedMarketData schema.')
