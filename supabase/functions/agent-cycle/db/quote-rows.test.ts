import { assertEquals } from 'jsr:@std/assert@1'
import { toQuoteRow, toRefreshErrorRows } from './quote-rows.ts'
import type { MarketQuote, NormalizedMarketData } from '../../../../src/shared/market-data/types.ts'

function quote(overrides: Partial<MarketQuote> = {}): MarketQuote {
  return {
    asset: 'BTC',
    provider: 'coingecko',
    dataAsOf: '2026-09-21T09:05:00.000Z',
    fetchedAt: '2026-09-21T09:05:02.123Z',
    price: 83299,
    change1hPct: 0.12,
    change24hPct: 3.71,
    change7dPct: -1.4,
    ...overrides,
  }
}

Deno.test('toQuoteRow: maps every field to its snake_case column', () => {
  const row = toQuoteRow(quote())
  assertEquals(row, {
    asset: 'BTC',
    price: 83299,
    change_1h_pct: 0.12,
    change_24h_pct: 3.71,
    change_7d_pct: -1.4,
    provider: 'coingecko',
    data_as_of: '2026-09-21T09:05:00.000Z',
    fetched_at: '2026-09-21T09:05:02.123Z',
    last_refresh_error: null,
    last_refresh_error_at: null,
  })
})

Deno.test('toQuoteRow: a successful refresh always clears both error columns, proving success overwrites a prior failure', () => {
  const row = toQuoteRow(quote())
  assertEquals(row.last_refresh_error, null)
  assertEquals(row.last_refresh_error_at, null)
})

Deno.test('toQuoteRow: null change-percentage fields pass through as null, not coerced to 0', () => {
  const row = toQuoteRow(quote({ change1hPct: null, change24hPct: null, change7dPct: null }))
  assertEquals(row.change_1h_pct, null)
  assertEquals(row.change_24h_pct, null)
  assertEquals(row.change_7d_pct, null)
})

// The structural-subset guarantee the "market_quotes plan" §4 depends on:
// agent-cycle already holds a full NormalizedMarketData from its own
// getMarketData call and must be able to pass it straight into this same
// mapper with no separate conversion step. TypeScript's structural typing
// (MarketQuote is a strict field subset) makes this compile; this test
// proves it also behaves correctly at runtime — the extra fields are
// simply never read.
Deno.test('toQuoteRow: accepts a full NormalizedMarketData unchanged, reading only the 8 quote fields', () => {
  const fullMarketData: NormalizedMarketData = {
    ...quote(),
    candles: [{ timestamp: '2026-09-21T08:00:00.000Z', open: 1, high: 2, low: 0.5, close: 1.5 }],
    closeSeries: [{ timestamp: '2026-09-21T08:00:00.000Z', close: 1.5 }],
    volumeSeries: [{ timestamp: '2026-09-21T08:00:00.000Z', volume: 100 }],
    dailyCloseSeries: [{ timestamp: '2026-09-21T00:00:00.000Z', close: 1.4 }],
  }
  const row = toQuoteRow(fullMarketData)
  assertEquals(row.price, 83299)
  assertEquals(row.data_as_of, '2026-09-21T09:05:00.000Z')
  // deno-lint-ignore no-explicit-any
  assertEquals(Object.hasOwn(row as any, 'candles'), false)
})

Deno.test('toQuoteRow: is pure — the same input produces deep-equal output every call', () => {
  const input = quote()
  assertEquals(toQuoteRow(input), toQuoteRow(input))
})

Deno.test('toRefreshErrorRows: one error row per requested asset, touching ONLY the two error columns', () => {
  const rows = toRefreshErrorRows(['BTC', 'ETH'], 'coingecko: 500 fetching /coins/markets', '2026-09-21T09:10:00.000Z')
  assertEquals(rows.length, 2)
  assertEquals(rows[0], {
    asset: 'BTC',
    last_refresh_error: 'coingecko: 500 fetching /coins/markets',
    last_refresh_error_at: '2026-09-21T09:10:00.000Z',
  })
  assertEquals(rows[1]!.asset, 'ETH')
  // Never price/change/provider/data_as_of/fetched_at — a partial-merge
  // upsert must leave those columns completely untouched on the existing
  // row (see the module comment: PostgREST only updates keys present in
  // the payload).
  assertEquals(Object.keys(rows[0]!).sort(), ['asset', 'last_refresh_error', 'last_refresh_error_at'])
})

Deno.test('toRefreshErrorRows: zero assets produces zero rows', () => {
  assertEquals(toRefreshErrorRows([], 'unused', '2026-09-21T09:10:00.000Z'), [])
})
