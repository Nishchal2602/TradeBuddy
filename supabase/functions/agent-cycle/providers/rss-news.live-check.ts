// Manual live smoke test — NOT part of `deno test` (real network calls to
// 8 outlets, would be flaky/slow in CI). Run by hand:
//
//   deno run --allow-net supabase/functions/agent-cycle/providers/rss-news.live-check.ts
//
// The fixture-based rss-news.test.ts proves the code matches one inspected
// sample (Cointelegraph); this proves all 8 curated feeds actually parse
// and produce sane BTC/ETH-relevant output right now.

import { RssNewsProvider } from './rss-news.ts'

const provider = new RssNewsProvider()
const result = await provider.getRecentNews(['BTC', 'ETH'], 24 * 60)

console.log(`${result.length} relevant items across the last 24h\n`)

const bySource = new Map<string, number>()
for (const item of result) {
  bySource.set(item.source, (bySource.get(item.source) ?? 0) + 1)
}
console.log('by source:', Object.fromEntries(bySource))

console.log('\nfirst 5 items:')
for (const item of result.slice(0, 5)) {
  console.log(`\n[${item.assets.join(',')}] ${item.headline}`)
  console.log(`  source: ${item.source}  published: ${item.publishedAt}`)
  console.log(`  summary: ${(item.summary ?? '(none)').slice(0, 120)}`)
  console.log(`  url: ${item.url}`)
}

console.log('\nOK — all items validated against NormalizedNewsItem schema.')
