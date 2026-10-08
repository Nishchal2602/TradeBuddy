import { z } from 'zod'
import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'
import { ProviderFetchError, ProviderRateLimitError, ProviderValidationError } from '../../../../src/shared/providers/errors.ts'

// RESEARCH-1 (2026-10-08, STRAT-1 P5) — public, read-only, unauthenticated
// Binance market-data endpoints, for the historical research engine ONLY.
// See context/project-overview.md's "Historical Market-Data Scope" section
// for the exact authorization boundary this file must stay inside:
// candles + funding rates, nothing else, ever. No API key is read anywhere
// in this file (deliberately — `Deno.env.get` never appears here), which
// is itself a cheap, permanent, grep-able proof this stayed in scope. Never
// import this file from a LIVE trading path (agent-cycle/index.ts,
// position-monitor, cycle-dispatcher) — it is consumed only by the
// research/ directory's own local scripts.

// Spot symbols for OHLCV (true per-interval volume — unlike CoinGecko's
// rolling-24h `total_volumes`, this is the actual traded volume in each
// candle, verified against Binance's own API docs before this file was
// written, same discipline coingecko.ts's own COIN_ID comment follows).
export const BINANCE_SPOT_SYMBOL: Record<AssetSymbol, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SUI: 'SUIUSDT',
  AVAX: 'AVAXUSDT',
}

// USDS-margined perpetual futures symbols, for funding-rate history only —
// a DIFFERENT market from the spot symbols above (funding is inherently a
// perpetual-futures concept; see the research plan's own "Spot price
// process, futures funding economics" honest-limitations note). Verified
// identical symbol strings to the spot pairs on Binance's USDS-M futures.
export const BINANCE_FUTURES_SYMBOL: Record<AssetSymbol, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SUI: 'SUIUSDT',
  AVAX: 'AVAXUSDT',
}

const SPOT_BASE_URL = 'https://api.binance.com/api/v3'
const FUTURES_BASE_URL = 'https://fapi.binance.com/fapi/v1'

export const BINANCE_KLINE_MAX_LIMIT = 1000
export const BINANCE_FUNDING_MAX_LIMIT = 1000

// The four native Binance kline intervals the live strategy's own
// deterministic layers actually operate on — 30m signal bars, 1h (the fade
// arm's RSI/distance-from-range leg, per CFG-1 Stage 2's own "hourly
// closeSeries/volumeSeries" finding), 4h bias, 1d regime. Deliberately NOT
// fetching 1-minute bars: none of the live code reads anything finer than
// these four, so doing so would only add ingestion volume and time for
// zero fidelity gain (see the research plan's own "What this buys"
// reasoning).
export type HistoricalTimeframe = '30m' | '1h' | '4h' | '1d'

export interface HistoricalKline {
  openTime: string
  closeTime: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface HistoricalFundingRate {
  fundingTime: string
  fundingRate: number
  markPrice: number
}

// --- Raw response schemas ---------------------------------------------
//
// Verified directly against Binance's own API documentation (developers.
// binance.com) before this file was written, same "confirmed live/from
// docs, not assumed" discipline coingecko.ts's own comments follow.

// [openTime, open, high, low, close, volume, closeTime, quoteAssetVolume,
// numberOfTrades, takerBuyBaseVolume, takerBuyQuoteVolume, ignore] — 12
// elements. open/high/low/close/volume/quoteAssetVolume/taker* come back
// as strings; openTime/closeTime/numberOfTrades as numbers. This schema
// validates only the positions this adapter reads.
const BinanceKline = z.tuple([
  z.number(), // openTime (ms)
  z.string(), // open
  z.string(), // high
  z.string(), // low
  z.string(), // close
  z.string(), // volume
  z.number(), // closeTime (ms)
  z.string(), // quoteAssetVolume
  z.number(), // numberOfTrades
  z.string(), // takerBuyBaseVolume
  z.string(), // takerBuyQuoteVolume
  z.string(), // ignore
])
const BinanceKlinesResponse = z.array(BinanceKline)

const BinanceFundingRateEntry = z.object({
  symbol: z.string(),
  fundingRate: z.string(),
  fundingTime: z.number(),
  markPrice: z.string(),
})
const BinanceFundingRateResponse = z.array(BinanceFundingRateEntry)

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response
  try {
    response = await fetchImpl(url)
  } catch (cause) {
    throw new ProviderFetchError(`binance: network error fetching ${url}`, 'binance', cause)
  }

  if (response.status === 429 || response.status === 418) {
    const retryAfterHeader = response.headers.get('retry-after')
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined
    throw new ProviderRateLimitError('binance', Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined)
  }

  if (!response.ok) {
    throw new ProviderFetchError(`binance: ${response.status} ${response.statusText} fetching ${url}`, 'binance')
  }

  try {
    return await response.json()
  } catch (cause) {
    throw new ProviderFetchError(`binance: malformed JSON from ${url}`, 'binance', cause)
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown, context: string): T {
  const result = schema.safeParse(raw)
  if (!result.success) {
    throw new ProviderValidationError(`binance: unexpected response shape (${context})`, 'binance', result.error.issues)
  }
  return result.data
}

// Spot klines — true OHLCV, the live strategy's own signal source.
// startTimeMs/endTimeMs are both inclusive per Binance's own docs.
export async function fetchKlines(
  asset: AssetSymbol,
  interval: HistoricalTimeframe,
  startTimeMs: number,
  endTimeMs?: number,
  limit: number = BINANCE_KLINE_MAX_LIMIT,
  fetchImpl: typeof fetch = fetch,
): Promise<HistoricalKline[]> {
  const symbol = BINANCE_SPOT_SYMBOL[asset]
  const params = new URLSearchParams({ symbol, interval, startTime: String(startTimeMs), limit: String(limit) })
  if (endTimeMs !== undefined) params.set('endTime', String(endTimeMs))
  const raw = await fetchJson(`${SPOT_BASE_URL}/klines?${params}`, fetchImpl)
  const parsed = parseOrThrow(BinanceKlinesResponse, raw, `klines ${symbol}/${interval}`)
  return parsed.map((k) => ({
    openTime: new Date(k[0]).toISOString(),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: new Date(k[6]).toISOString(),
  }))
}

// USDS-M perpetual funding-rate history — research-only cost model input,
// never consumed by the live trading path (which has its own, separate,
// currently-dormant-since-shortEnabled=false funding model in
// broker/accounting.ts, unmodified by this file).
export async function fetchFundingRateHistory(
  asset: AssetSymbol,
  startTimeMs: number,
  endTimeMs?: number,
  limit: number = BINANCE_FUNDING_MAX_LIMIT,
  fetchImpl: typeof fetch = fetch,
): Promise<HistoricalFundingRate[]> {
  const symbol = BINANCE_FUTURES_SYMBOL[asset]
  const params = new URLSearchParams({ symbol, startTime: String(startTimeMs), limit: String(limit) })
  if (endTimeMs !== undefined) params.set('endTime', String(endTimeMs))
  const raw = await fetchJson(`${FUTURES_BASE_URL}/fundingRate?${params}`, fetchImpl)
  const parsed = parseOrThrow(BinanceFundingRateResponse, raw, `fundingRate ${symbol}`)
  return parsed.map((f) => ({
    fundingTime: new Date(f.fundingTime).toISOString(),
    fundingRate: Number(f.fundingRate),
    markPrice: Number(f.markPrice),
  }))
}
