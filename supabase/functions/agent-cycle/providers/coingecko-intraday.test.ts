import { assertEquals } from 'jsr:@std/assert@1'
import { fetchIntradayMarketData } from './coingecko.ts'

// Aggressive strategy (v3-jev-intraday-30m) — fetchIntradayMarketData
// tests. Fixtures are structurally faithful to what OHLC_FIXTURE/
// MARKET_CHART_FIXTURE in coingecko.test.ts already establish as real
// live-verified shapes (4h-spaced /ohlc, 1h-spaced /market_chart) — here
// re-timed to this function's own days=1 intervals: 30 minutes
// (1_800_000ms) for /ohlc, 5 minutes (300_000ms) for /market_chart.

const OHLC_1D_FIXTURE = [
  [1787068800000, 64284.0, 64946.0, 64014.0, 64818.0],
  [1787068800000 + 1_800_000, 64818.0, 64844.0, 64604.0, 64608.0], // +30min
  [1787068800000 + 3_600_000, 64608.0, 64700.0, 64500.0, 64650.0], // +60min
]

const CHART_1D_FIXTURE = {
  prices: [
    [1787068800000, 64284.0],
    [1787068800000 + 300_000, 64300.0], // +5min
    [1787068800000 + 600_000, 64310.0], // +10min
  ],
  total_volumes: [
    [1787068800000, 1_000_000],
    [1787068800000 + 300_000, 1_100_000],
    [1787068800000 + 600_000, 1_200_000],
  ],
}

// A trailing off-grid live point — gap shorter than 5min — reproducing
// the same trailing-live-point shape closed-bars.ts's own live-verified
// finding documents for every /market_chart granularity this project uses.
const CHART_1D_WITH_LIVE_POINT_FIXTURE = {
  prices: [...CHART_1D_FIXTURE.prices, [1787068800000 + 600_000 + 3 * 60 * 1000, 64320.0]], // +3min, not +5min
  total_volumes: [...CHART_1D_FIXTURE.total_volumes, [1787068800000 + 600_000 + 3 * 60 * 1000, 1_250_000]],
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function fixtureFetch(overrides: Partial<Record<'ohlc' | 'chart', () => Response>> = {}) {
  let calls = 0
  const fetchImpl = (url: string | URL): Promise<Response> => {
    calls++
    const href = url.toString()
    if (href.includes('/ohlc')) return Promise.resolve(overrides.ohlc ? overrides.ohlc() : jsonResponse(OHLC_1D_FIXTURE))
    if (href.includes('/market_chart')) return Promise.resolve(overrides.chart ? overrides.chart() : jsonResponse(CHART_1D_FIXTURE))
    throw new Error(`fixtureFetch: unexpected URL ${href}`)
  }
  return { fetchImpl: fetchImpl as unknown as typeof fetch, callCount: () => calls }
}

Deno.test('fetchIntradayMarketData: empty asset list makes zero requests and returns {}', async () => {
  const { fetchImpl, callCount } = fixtureFetch()
  const result = await fetchIntradayMarketData([], fetchImpl)
  assertEquals(result, {})
  assertEquals(callCount(), 0)
})

Deno.test('fetchIntradayMarketData: one asset costs exactly 2 requests (ohlc + chart), never more', async () => {
  const { fetchImpl, callCount } = fixtureFetch()
  await fetchIntradayMarketData(['BTC'], fetchImpl)
  assertEquals(callCount(), 2)
})

Deno.test('fetchIntradayMarketData: both assets requested concurrently, each correctly keyed', async () => {
  const { fetchImpl, callCount } = fixtureFetch()
  const result = await fetchIntradayMarketData(['BTC', 'ETH'], fetchImpl)
  assertEquals(callCount(), 4) // 2 requests x 2 assets
  assertEquals(Object.keys(result).sort(), ['BTC', 'ETH'])
})

Deno.test('fetchIntradayMarketData: ohlc30m is normalized true OHLC, in order, with ISO timestamps', async () => {
  const { fetchImpl } = fixtureFetch()
  const result = await fetchIntradayMarketData(['BTC'], fetchImpl)
  const btc = result.BTC!
  assertEquals(btc.ohlc30m.length, 3)
  assertEquals(btc.ohlc30m[0], { timestamp: new Date(1787068800000).toISOString(), open: 64284.0, high: 64946.0, low: 64014.0, close: 64818.0 })
})

Deno.test('fetchIntradayMarketData: spot5m pairs price with volume from the SAME response — not silently discarded like fetchRecentPricePoints does', async () => {
  const { fetchImpl } = fixtureFetch()
  const result = await fetchIntradayMarketData(['BTC'], fetchImpl)
  const btc = result.BTC!
  assertEquals(btc.spot5m.length, 3)
  assertEquals(btc.spot5m[0], { timestamp: new Date(1787068800000).toISOString(), price: 64284.0, volume: 1_000_000 })
  assertEquals(btc.spot5m[2]!.volume, 1_200_000)
})

Deno.test('fetchIntradayMarketData: spot5m drops the trailing off-grid live point via closedPoints, same as every other granularity in this pipeline', async () => {
  const { fetchImpl } = fixtureFetch({ chart: () => jsonResponse(CHART_1D_WITH_LIVE_POINT_FIXTURE) })
  const result = await fetchIntradayMarketData(['BTC'], fetchImpl)
  // 4 raw points in the fixture, but the trailing one is off-grid (+3min
  // instead of +5min) and must be dropped.
  assertEquals(result.BTC!.spot5m.length, 3)
})

Deno.test('fetchIntradayMarketData: asset field on the returned data matches the requested asset', async () => {
  const { fetchImpl } = fixtureFetch()
  const result = await fetchIntradayMarketData(['ETH'], fetchImpl)
  assertEquals(result.ETH!.asset, 'ETH')
})
