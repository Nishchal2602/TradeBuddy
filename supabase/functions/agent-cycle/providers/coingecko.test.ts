import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { CoinGeckoMarketDataProvider, fetchRecentPricePoints } from './coingecko.ts'
import {
  ProviderFetchError,
  ProviderRateLimitError,
  ProviderValidationError,
} from '../../../../src/shared/providers/errors.ts'

// Fixtures are trimmed but structurally faithful to real responses captured
// live from api.coingecko.com on 2026-09-17 (see progress-tracker.md) —
// field names, nesting, and timestamp-in-ms-vs-ISO conventions all match
// what the real API actually returned, not what the docs merely describe.

const MARKETS_FIXTURE = [
  {
    id: 'bitcoin',
    current_price: 76851,
    total_volume: 29567170533,
    last_updated: '2026-09-17T12:22:10.000Z',
    price_change_percentage_1h_in_currency: 0.0,
    price_change_percentage_24h_in_currency: 1.11918,
    price_change_percentage_7d_in_currency: -2.0,
  },
  {
    id: 'ethereum',
    current_price: 2459.19,
    total_volume: 15376911296,
    last_updated: '2026-09-17T12:22:05.000Z',
    price_change_percentage_1h_in_currency: 0.3,
    price_change_percentage_24h_in_currency: 2.0644,
    price_change_percentage_7d_in_currency: -1.2,
  },
]

// Real /ohlc timestamps are exactly 4h (14_400_000ms) apart.
const OHLC_FIXTURE = [
  [1787068800000, 64284.0, 64946.0, 64014.0, 64818.0],
  [1787083200000, 64818.0, 64844.0, 64604.0, 64608.0],
]

// Real /market_chart timestamps are exactly 1h (3_600_000ms) apart.
const MARKET_CHART_FIXTURE = {
  prices: [
    [1787058000000, 64157.62131397192],
    [1787061600000, 64165.81470769047],
  ],
  total_volumes: [
    [1787058000000, 1234567.89],
    [1787061600000, 1244567.89],
  ],
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

// Routes by URL substring, mirroring how CoinGeckoMarketDataProvider
// actually builds its three endpoint URLs — a realistic double, not a
// call-count stub.
function fixtureFetch(overrides: Partial<Record<'markets' | 'ohlc' | 'chart', () => Response>> = {}) {
  return (url: string | URL): Promise<Response> => {
    const href = url.toString()
    if (href.includes('/coins/markets')) {
      return Promise.resolve(overrides.markets ? overrides.markets() : jsonResponse(MARKETS_FIXTURE))
    }
    if (href.includes('/ohlc')) {
      return Promise.resolve(overrides.ohlc ? overrides.ohlc() : jsonResponse(OHLC_FIXTURE))
    }
    if (href.includes('/market_chart')) {
      return Promise.resolve(overrides.chart ? overrides.chart() : jsonResponse(MARKET_CHART_FIXTURE))
    }
    throw new Error(`fixtureFetch: unexpected URL ${href}`)
  }
}

Deno.test('getMarketData: normalizes a happy-path response for both assets', async () => {
  const provider = new CoinGeckoMarketDataProvider(fixtureFetch() as typeof fetch)
  const result = await provider.getMarketData(['BTC', 'ETH'])

  assertEquals(result.length, 2)

  const btc = result.find((r) => r.asset === 'BTC')!
  assertEquals(btc.provider, 'coingecko')
  assertEquals(btc.price, 76851)
  assertEquals(btc.change24hPct, 1.11918)
  assertEquals(btc.dataAsOf, '2026-09-17T12:22:10.000Z')
  assertEquals(btc.candles.length, 2)
  assertEquals(btc.candles[0], {
    timestamp: '2026-08-18T16:00:00.000Z',
    open: 64284.0,
    high: 64946.0,
    low: 64014.0,
    close: 64818.0,
  })
  assertEquals(btc.closeSeries.length, 2)
  assertEquals(btc.closeSeries[0]!.timestamp, '2026-08-18T13:00:00.000Z')
  assertEquals(btc.volumeSeries[0], { timestamp: '2026-08-18T13:00:00.000Z', volume: 1234567.89 })

  const eth = result.find((r) => r.asset === 'ETH')!
  assertEquals(eth.price, 2459.19)
})

Deno.test('getMarketData: empty asset list makes zero requests and returns []', async () => {
  const calls: string[] = []
  const provider = new CoinGeckoMarketDataProvider(((url: string) => {
    calls.push(url)
    throw new Error('should never be called')
  }) as unknown as typeof fetch)

  const result = await provider.getMarketData([])
  assertEquals(result, [])
  assertEquals(calls.length, 0)
})

Deno.test('getMarketData: asset missing from /coins/markets throws ProviderValidationError', async () => {
  const provider = new CoinGeckoMarketDataProvider(
    fixtureFetch({ markets: () => jsonResponse([MARKETS_FIXTURE[0]]) }) as typeof fetch,
  )
  await assertRejects(() => provider.getMarketData(['BTC', 'ETH']), ProviderValidationError)
})

Deno.test('getMarketData: malformed /coins/markets entry throws ProviderValidationError', async () => {
  const provider = new CoinGeckoMarketDataProvider(
    fixtureFetch({
      markets: () => jsonResponse([{ id: 'bitcoin', current_price: 'not-a-number' }]),
    }) as typeof fetch,
  )
  await assertRejects(() => provider.getMarketData(['BTC']), ProviderValidationError)
})

Deno.test('getMarketData: non-JSON body throws ProviderFetchError', async () => {
  const provider = new CoinGeckoMarketDataProvider(
    fixtureFetch({ markets: () => new Response('not json{{{', { status: 200 }) }) as typeof fetch,
  )
  await assertRejects(() => provider.getMarketData(['BTC']), ProviderFetchError)
})

Deno.test('getMarketData: HTTP 429 throws ProviderRateLimitError with retry-after', async () => {
  const provider = new CoinGeckoMarketDataProvider(
    fixtureFetch({
      markets: () => new Response(null, { status: 429, headers: { 'retry-after': '30' } }),
    }) as typeof fetch,
  )
  const err = await assertRejects(
    () => provider.getMarketData(['BTC']),
    ProviderRateLimitError,
  )
  assertEquals((err as ProviderRateLimitError).retryAfterSeconds, 30)
})

Deno.test('getMarketData: HTTP 500 throws ProviderFetchError', async () => {
  const provider = new CoinGeckoMarketDataProvider(
    fixtureFetch({
      markets: () => new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }),
    }) as typeof fetch,
  )
  await assertRejects(() => provider.getMarketData(['BTC']), ProviderFetchError)
})

Deno.test('getMarketData: network failure throws ProviderFetchError', async () => {
  const provider = new CoinGeckoMarketDataProvider((() => {
    throw new TypeError('fetch failed')
  }) as unknown as typeof fetch)
  await assertRejects(() => provider.getMarketData(['BTC']), ProviderFetchError)
})

// --- fetchRecentPricePoints (Step 5 — position monitor's 5-minute feed) ---

const FIVE_MIN_CHART_FIXTURE = {
  prices: [
    [1787058000000, 76800.5],
    [1787058300000, 76812.1], // +5 min
    [1787058600000, 76790.0], // +5 min
  ],
  total_volumes: [
    [1787058000000, 1000],
    [1787058300000, 1010],
    [1787058600000, 990],
  ],
}

Deno.test('fetchRecentPricePoints: parses days=1 market_chart into {timestamp, price} points, dropping volume', () => {
  const fetchImpl = ((url: string) => {
    if (!url.includes('days=1')) throw new Error(`expected a days=1 request, got ${url}`)
    return Promise.resolve(jsonResponse(FIVE_MIN_CHART_FIXTURE))
  }) as unknown as typeof fetch

  return fetchRecentPricePoints(['BTC'], fetchImpl).then((result) => {
    const btc = result.BTC!
    assertEquals(btc.length, 3)
    assertEquals(btc[0], { timestamp: '2026-08-18T13:00:00.000Z', price: 76800.5 })
    assertEquals(btc[1], { timestamp: '2026-08-18T13:05:00.000Z', price: 76812.1 })
    // no `volume` field leaks through — this function is price-only
    assertEquals(Object.keys(btc[0]!).sort(), ['price', 'timestamp'])
  })
})

Deno.test('fetchRecentPricePoints: empty asset list makes zero requests and returns {}', async () => {
  const calls: string[] = []
  const fetchImpl = ((url: string) => {
    calls.push(url)
    throw new Error('should never be called')
  }) as unknown as typeof fetch

  const result = await fetchRecentPricePoints([], fetchImpl)
  assertEquals(result, {})
  assertEquals(calls.length, 0)
})

Deno.test('fetchRecentPricePoints: both assets fetched concurrently, each keyed correctly', async () => {
  const fetchImpl = ((url: string) => {
    const isEth = url.includes('/coins/ethereum/')
    return Promise.resolve(jsonResponse(isEth
      ? { prices: [[1787058000000, 2500]], total_volumes: [[1787058000000, 500]] }
      : FIVE_MIN_CHART_FIXTURE))
  }) as unknown as typeof fetch

  const result = await fetchRecentPricePoints(['BTC', 'ETH'], fetchImpl)
  assertEquals(result.BTC!.length, 3)
  assertEquals(result.ETH!.length, 1)
  assertEquals(result.ETH![0]!.price, 2500)
})

Deno.test('fetchRecentPricePoints: HTTP failure on one asset throws (fail-closed, not a partial result)', async () => {
  const fetchImpl = ((url: string) => {
    if (url.includes('/coins/ethereum/')) {
      return Promise.resolve(new Response('error', { status: 500 }))
    }
    return Promise.resolve(jsonResponse(FIVE_MIN_CHART_FIXTURE))
  }) as unknown as typeof fetch

  await assertRejects(() => fetchRecentPricePoints(['BTC', 'ETH'], fetchImpl), ProviderFetchError)
})
