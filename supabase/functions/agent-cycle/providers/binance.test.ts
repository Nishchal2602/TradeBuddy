import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { BINANCE_FUTURES_SYMBOL, BINANCE_SPOT_SYMBOL, fetchFundingRateHistory, fetchKlines } from './binance.ts'
import { ProviderFetchError, ProviderRateLimitError, ProviderValidationError } from '../../../../src/shared/providers/errors.ts'
import { AssetSymbol } from '../../../../src/shared/market-data/types.ts'

// Structurally faithful to the real shape confirmed against Binance's own
// API documentation (developers.binance.com) before this file was written
// — field order, string-vs-number typing per position, and the 12-element
// kline array are all as documented. 30m-spaced timestamps.
const KLINES_FIXTURE = [
  [1727654400000, '64000.00', '64500.00', '63800.00', '64300.00', '123.456', 1727656199999, '7912345.67', 4201, '61.2', '3900000.1', '0'],
  [1727656200000, '64300.00', '64700.00', '64100.00', '64600.00', '98.765', 1727657999999, '6345678.90', 3987, '49.1', '3100000.2', '0'],
]

const FUNDING_FIXTURE = [
  { symbol: 'BTCUSDT', fundingRate: '0.00010000', fundingTime: 1727654400000, markPrice: '64310.50' },
  { symbol: 'BTCUSDT', fundingRate: '-0.00005000', fundingTime: 1727683200000, markPrice: '64550.25' },
]

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init })
}

// --- symbol-universe completeness (mirrors asset-universe.test.ts's own discipline) ---

Deno.test('BINANCE_SPOT_SYMBOL and BINANCE_FUTURES_SYMBOL cover every AssetSymbol, nothing more', () => {
  assertEquals(Object.keys(BINANCE_SPOT_SYMBOL).sort(), [...AssetSymbol.options].sort())
  assertEquals(Object.keys(BINANCE_FUTURES_SYMBOL).sort(), [...AssetSymbol.options].sort())
})

// --- fetchKlines ---------------------------------------------------------

Deno.test('fetchKlines: parses the 12-element array into typed OHLCV + ISO timestamps', async () => {
  const fetchImpl = (() => Promise.resolve(jsonResponse(KLINES_FIXTURE))) as unknown as typeof fetch
  const result = await fetchKlines('BTC', '30m', 1727654400000, undefined, 1000, fetchImpl)
  assertEquals(result, [
    { openTime: '2024-09-30T00:00:00.000Z', closeTime: '2024-09-30T00:29:59.999Z', open: 64000, high: 64500, low: 63800, close: 64300, volume: 123.456 },
    { openTime: '2024-09-30T00:30:00.000Z', closeTime: '2024-09-30T00:59:59.999Z', open: 64300, high: 64700, low: 64100, close: 64600, volume: 98.765 },
  ])
})

Deno.test('fetchKlines: builds the request URL with symbol/interval/startTime/limit, and endTime only when supplied', async () => {
  let capturedUrl = ''
  const fetchImpl = ((url: string) => {
    capturedUrl = url
    return Promise.resolve(jsonResponse([]))
  }) as unknown as typeof fetch
  await fetchKlines('ETH', '4h', 1000, undefined, 500, fetchImpl)
  assertEquals(capturedUrl.startsWith('https://api.binance.com/api/v3/klines?'), true)
  assertEquals(capturedUrl.includes('symbol=ETHUSDT'), true)
  assertEquals(capturedUrl.includes('interval=4h'), true)
  assertEquals(capturedUrl.includes('startTime=1000'), true)
  assertEquals(capturedUrl.includes('limit=500'), true)
  assertEquals(capturedUrl.includes('endTime'), false)

  await fetchKlines('ETH', '4h', 1000, 2000, 500, fetchImpl)
  assertEquals(capturedUrl.includes('endTime=2000'), true)
})

Deno.test('fetchKlines: HTTP 429 throws ProviderRateLimitError with retry-after', async () => {
  const fetchImpl = (() => Promise.resolve(new Response(null, { status: 429, headers: { 'retry-after': '10' } }))) as unknown as typeof fetch
  const err = await assertRejects(() => fetchKlines('BTC', '1d', 0, undefined, 1000, fetchImpl), ProviderRateLimitError)
  assertEquals((err as InstanceType<typeof ProviderRateLimitError>).retryAfterSeconds, 10)
})

Deno.test('fetchKlines: HTTP 418 (Binance\'s own IP-ban status) also throws ProviderRateLimitError', async () => {
  const fetchImpl = (() => Promise.resolve(new Response(null, { status: 418 }))) as unknown as typeof fetch
  await assertRejects(() => fetchKlines('BTC', '1d', 0, undefined, 1000, fetchImpl), ProviderRateLimitError)
})

Deno.test('fetchKlines: non-2xx, non-429/418 throws ProviderFetchError', async () => {
  const fetchImpl = (() => Promise.resolve(new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }))) as unknown as typeof fetch
  await assertRejects(() => fetchKlines('BTC', '1d', 0, undefined, 1000, fetchImpl), ProviderFetchError)
})

Deno.test('fetchKlines: malformed JSON throws ProviderFetchError', async () => {
  const fetchImpl = (() => Promise.resolve(new Response('not json{{{', { status: 200 }))) as unknown as typeof fetch
  await assertRejects(() => fetchKlines('BTC', '1d', 0, undefined, 1000, fetchImpl), ProviderFetchError)
})

Deno.test('fetchKlines: a response that does not match the 12-element kline shape throws ProviderValidationError', async () => {
  const fetchImpl = (() => Promise.resolve(jsonResponse([['not', 'a', 'kline']]))) as unknown as typeof fetch
  await assertRejects(() => fetchKlines('BTC', '1d', 0, undefined, 1000, fetchImpl), ProviderValidationError)
})

Deno.test('fetchKlines: network throw wraps as ProviderFetchError, never a raw error', async () => {
  const fetchImpl = (() => Promise.reject(new Error('dns failure'))) as unknown as typeof fetch
  await assertRejects(() => fetchKlines('BTC', '1d', 0, undefined, 1000, fetchImpl), ProviderFetchError)
})

// --- fetchFundingRateHistory ---------------------------------------------

Deno.test('fetchFundingRateHistory: parses funding entries into typed values + ISO timestamps, dropping symbol', async () => {
  const fetchImpl = (() => Promise.resolve(jsonResponse(FUNDING_FIXTURE))) as unknown as typeof fetch
  const result = await fetchFundingRateHistory('BTC', 1727654400000, undefined, 1000, fetchImpl)
  assertEquals(result, [
    { fundingTime: '2024-09-30T00:00:00.000Z', fundingRate: 0.0001, markPrice: 64310.5 },
    { fundingTime: '2024-09-30T08:00:00.000Z', fundingRate: -0.00005, markPrice: 64550.25 },
  ])
})

Deno.test('fetchFundingRateHistory: request URL hits the futures funding-rate endpoint with the right symbol', async () => {
  let capturedUrl = ''
  const fetchImpl = ((url: string) => {
    capturedUrl = url
    return Promise.resolve(jsonResponse([]))
  }) as unknown as typeof fetch
  await fetchFundingRateHistory('AVAX', 0, undefined, 1000, fetchImpl)
  assertEquals(capturedUrl.startsWith('https://fapi.binance.com/fapi/v1/fundingRate?'), true)
  assertEquals(capturedUrl.includes('symbol=AVAXUSDT'), true)
})

Deno.test('fetchFundingRateHistory: HTTP 429 throws ProviderRateLimitError', async () => {
  const fetchImpl = (() => Promise.resolve(new Response(null, { status: 429 }))) as unknown as typeof fetch
  await assertRejects(() => fetchFundingRateHistory('BTC', 0, undefined, 1000, fetchImpl), ProviderRateLimitError)
})
