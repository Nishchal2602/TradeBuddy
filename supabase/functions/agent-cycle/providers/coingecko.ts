import { z } from 'zod'
import type { AssetSymbol, NormalizedMarketData, MarketQuote, OhlcCandle } from '../../../../src/shared/market-data/types.ts'
import type { IntradayMarketData, IntradaySpotPoint } from '../strategy/aggressive/types.ts'
import { NormalizedMarketData as NormalizedMarketDataSchema, MarketQuote as MarketQuoteSchema } from '../../../../src/shared/market-data/types.ts'
import type { MarketDataProvider } from '../../../../src/shared/market-data/provider.ts'
import {
  ProviderFetchError,
  ProviderRateLimitError,
  ProviderValidationError,
} from '../../../../src/shared/providers/errors.ts'
// Returned directly by fetchRecentPricePoints below rather than a locally
// redefined (and structurally identical) type — the shape is "owned" by
// the trigger-detection logic that consumes it (position-monitor/
// triggers.ts), matching how NormalizedMarketData is owned by
// src/shared/market-data/types.ts and merely produced here.
import type { PricePoint } from '../../position-monitor/triggers.ts'
import { closedPoints } from '../strategy/closed-bars.ts'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

// CoinGecko coin ids for the V0 asset universe. Entirely internal to this
// file — nothing outside ever sees the string "bitcoin"/"ethereum". This is
// the concrete point of "the agent cycle only knows about the normalized
// interfaces" (user direction, 2026-09-17): a provider-specific id scheme
// must never leak past this adapter.
const COIN_ID: Record<AssetSymbol, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
}

const BASE_URL = 'https://api.coingecko.com/api/v3'

// Every request in this file goes through fetchJson, which sends this
// header whenever an apiKey is provided — CoinGecko's free Demo API key
// (2026-09-22, found live: the fully anonymous public endpoint this file
// used until now is rate-limited to 5-15 calls/min, SHARED across all of
// CoinGecko's worldwide anonymous traffic; a Demo key raises that to a
// stable 100/min + 10,000/month, which is what "10,000 calls/month" in
// CoinGecko's own docs actually refers to — not the keyless tier).
// Optional everywhere it's threaded through: keyless access still works
// (just at the much stricter limit), so a missing/unset key degrades
// gracefully rather than throwing — useful for local dev/tests, which
// never set one.
const API_KEY_HEADER = 'x-cg-demo-api-key'

// --- Raw response schemas -------------------------------------------------
//
// These validate only the fields this adapter actually reads. CoinGecko's
// real responses carry many more (ath, market_cap_rank, image, ...);
// Zod objects ignore unrecognized keys by default, so this is a narrowing
// contract, not a full mirror of their API. Field names and granularity
// below were confirmed against live, unauthenticated responses on
// 2026-09-17 (see progress-tracker.md) — not assumed from docs alone.

const CoinGeckoMarketsEntry = z.object({
  id: z.string(),
  current_price: z.number().positive(),
  total_volume: z.number().nonnegative(),
  last_updated: z.string().datetime(),
  price_change_percentage_1h_in_currency: z.number().nullable().optional(),
  price_change_percentage_24h_in_currency: z.number().nullable().optional(),
  price_change_percentage_7d_in_currency: z.number().nullable().optional(),
})

const CoinGeckoMarketsResponse = z.array(CoinGeckoMarketsEntry)

// [timestamp_ms, open, high, low, close]. days=3..30 -> 4-hourly candles on
// the free tier (confirmed live) — coarser than closeSeries below by
// design; see types.ts's comment on `candles` vs `closeSeries`.
const CoinGeckoOhlcResponse = z.array(z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
]))

// days=2..90 -> hourly on the free tier (confirmed live) — this is the
// endpoint that actually delivers project-overview.md's "~24 recent hourly
// closes," not /ohlc.
const CoinGeckoMarketChartResponse = z.object({
  prices: z.array(z.tuple([z.number(), z.number()])),
  total_volumes: z.array(z.tuple([z.number(), z.number()])),
})

// --- Fetch helper ----------------------------------------------------------

function msToIso(ms: number): string {
  return new Date(ms).toISOString()
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  apiKey?: string,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetchImpl(url, apiKey ? { headers: { [API_KEY_HEADER]: apiKey } } : undefined)
  } catch (cause) {
    throw new ProviderFetchError(`coingecko: network error fetching ${url}`, 'coingecko', cause)
  }

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get('retry-after')
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined
    throw new ProviderRateLimitError(
      'coingecko',
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    )
  }

  if (!response.ok) {
    throw new ProviderFetchError(
      `coingecko: ${response.status} ${response.statusText} fetching ${url}`,
      'coingecko',
    )
  }

  try {
    return await response.json()
  } catch (cause) {
    throw new ProviderFetchError(`coingecko: malformed JSON from ${url}`, 'coingecko', cause)
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown, context: string): T {
  const result = schema.safeParse(raw)
  if (!result.success) {
    throw new ProviderValidationError(
      `coingecko: unexpected response shape (${context})`,
      'coingecko',
      result.error.issues,
    )
  }
  return result.data
}

// One batched /coins/markets call for every requested asset — the single
// most reused piece of this file. Shared by CoinGeckoMarketDataProvider
// (which layers three more per-asset requests on top, below) and
// fetchLatestQuotes (which needs nothing more than this). Module-private,
// not a method: neither caller needs an instance to use it, and it takes
// fetchImpl/baseUrl as plain params so fetchLatestQuotes's own defaulted
// signature can pass them straight through, same shape as fetchJson.
async function fetchMarketsSummary(
  assets: AssetSymbol[],
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey?: string,
): Promise<z.infer<typeof CoinGeckoMarketsResponse>> {
  const ids = assets.map((asset) => COIN_ID[asset])
  const marketsUrl =
    `${baseUrl}/coins/markets?vs_currency=usd&ids=${ids.join(',')}` +
    `&price_change_percentage=1h,24h,7d`
  const marketsRaw = await fetchJson(marketsUrl, fetchImpl, apiKey)
  return parseOrThrow(CoinGeckoMarketsResponse, marketsRaw, '/coins/markets')
}

// Shared by fetchOneAsset (below) and fetchLatestQuotes — both need "the
// one /coins/markets entry for this asset, or a validation error naming
// exactly what was requested vs. what came back."
function findMarketEntry(
  asset: AssetSymbol,
  markets: z.infer<typeof CoinGeckoMarketsResponse>,
): z.infer<typeof CoinGeckoMarketsEntry> {
  const coinId = COIN_ID[asset]
  const marketEntry = markets.find((entry) => entry.id === coinId)
  if (!marketEntry) {
    throw new ProviderValidationError(
      `coingecko: /coins/markets response did not include requested asset ${asset} (${coinId})`,
      'coingecko',
      { requested: coinId, received: markets.map((m) => m.id) },
    )
  }
  return marketEntry
}

// The exact field mapping MarketQuote needs — also the first eight fields
// of a full NormalizedMarketData (fetchOneAsset spreads this same object
// below, rather than re-listing the fields a second time). Kept as a
// plain, unvalidated object here; each caller validates the shape it
// actually needs (MarketQuote vs. the full NormalizedMarketData) at its
// own boundary via parseOrThrow, matching this file's existing
// "parse once, at the point a caller commits to a specific output shape"
// convention.
function toQuoteFields(asset: AssetSymbol, marketEntry: z.infer<typeof CoinGeckoMarketsEntry>, fetchedAt: string) {
  return {
    asset,
    provider: 'coingecko',
    dataAsOf: marketEntry.last_updated,
    fetchedAt,
    price: marketEntry.current_price,
    change1hPct: marketEntry.price_change_percentage_1h_in_currency ?? null,
    change24hPct: marketEntry.price_change_percentage_24h_in_currency ?? null,
    change7dPct: marketEntry.price_change_percentage_7d_in_currency ?? null,
  }
}

// --- Provider ----------------------------------------------------------

export class CoinGeckoMarketDataProvider implements MarketDataProvider {
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string
  private readonly apiKey?: string

  // Style note: explicit fields + manual assignment rather than TS
  // constructor parameter-property shorthand — see src/shared/providers/
  // errors.ts for why (erasableSyntaxOnly).
  constructor(fetchImpl: typeof fetch = fetch, baseUrl: string = BASE_URL, apiKey?: string) {
    this.fetchImpl = fetchImpl
    this.baseUrl = baseUrl
    this.apiKey = apiKey
  }

  async getMarketData(assets: AssetSymbol[]): Promise<NormalizedMarketData[]> {
    if (assets.length === 0) return []

    const fetchedAt = new Date().toISOString()
    const markets = await fetchMarketsSummary(assets, this.fetchImpl, this.baseUrl, this.apiKey)

    const perAsset = await Promise.all(
      assets.map((asset) => this.fetchOneAsset(asset, markets, fetchedAt)),
    )

    return perAsset.map((data) => parseOrThrow(NormalizedMarketDataSchema, data, 'normalized output'))
  }

  private async fetchOneAsset(
    asset: AssetSymbol,
    markets: z.infer<typeof CoinGeckoMarketsResponse>,
    fetchedAt: string,
  ): Promise<NormalizedMarketData> {
    const coinId = COIN_ID[asset]
    const marketEntry = findMarketEntry(asset, markets)

    const ohlcUrl = `${this.baseUrl}/coins/${coinId}/ohlc?vs_currency=usd&days=30`
    const chartUrl = `${this.baseUrl}/coins/${coinId}/market_chart?vs_currency=usd&days=30`
    // days=120 -> daily granularity on the free tier (confirmed live,
    // 2026-09-21 — strategy-v1 Phase 0: 121 points, ~24h apart, for both
    // BTC and ETH). The sole feed for the trading-strategy-v1.md §7 regime
    // rule (50-day MA needs >=50 CLOSED daily points; 120 raw days leaves
    // ~119 after closedPoints trims the trailing live one — comfortable
    // headroom). A separate call, not a re-aggregation of chartUrl above:
    // that 30-day hourly window has nowhere near enough history.
    const dailyUrl = `${this.baseUrl}/coins/${coinId}/market_chart?vs_currency=usd&days=120`

    const [ohlcRaw, chartRaw, dailyRaw] = await Promise.all([
      fetchJson(ohlcUrl, this.fetchImpl, this.apiKey),
      fetchJson(chartUrl, this.fetchImpl, this.apiKey),
      fetchJson(dailyUrl, this.fetchImpl, this.apiKey),
    ])

    const ohlc = parseOrThrow(CoinGeckoOhlcResponse, ohlcRaw, `/coins/${coinId}/ohlc`)
    const chart = parseOrThrow(CoinGeckoMarketChartResponse, chartRaw, `/coins/${coinId}/market_chart`)
    const daily = parseOrThrow(CoinGeckoMarketChartResponse, dailyRaw, `/coins/${coinId}/market_chart (days=120)`)

    // closedPoints only — never applied to `candles`: /ohlc has no trailing
    // live point to drop (see closed-bars.ts's doc comment for the live
    // verification both facts rest on).
    const closeSeries = closedPoints(
      chart.prices.map(([ts, price]) => ({ timestamp: msToIso(ts), close: price })),
      HOUR_MS,
    )
    const volumeSeries = closedPoints(
      chart.total_volumes.map(([ts, volume]) => ({ timestamp: msToIso(ts), volume })),
      HOUR_MS,
    )
    const dailyCloseSeries = closedPoints(
      daily.prices.map(([ts, price]) => ({ timestamp: msToIso(ts), close: price })),
      DAY_MS,
    )

    return {
      ...toQuoteFields(asset, marketEntry, fetchedAt),
      candles: ohlc.map(([ts, open, high, low, close]) => ({
        timestamp: msToIso(ts),
        open,
        high,
        low,
        close,
      })),
      closeSeries,
      volumeSeries,
      dailyCloseSeries,
    }
  }
}

// --- Position-monitor price feed --------------------------------------
//
// days=1 -> 5-minute granularity on the free tier (confirmed live,
// 2026-09-18 — trading-domain-contract.md §5), genuinely finer than the
// hourly closeSeries getMarketData above uses (days=30). Standalone
// rather than a method on CoinGeckoMarketDataProvider: it doesn't return
// NormalizedMarketData and doesn't implement MarketDataProvider, so
// attaching it to that class would misrepresent what the class's own
// interface promises. Only the position monitor calls this; the decision
// cycle never does.

export async function fetchRecentPricePoints(
  assets: AssetSymbol[],
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = BASE_URL,
  apiKey?: string,
): Promise<Partial<Record<AssetSymbol, PricePoint[]>>> {
  // Promise.all fails fast on any single rejection (matching
  // getMarketData's own "throw rather than partial" convention above), so
  // every requested asset is genuinely guaranteed present whenever this
  // resolves at all — Partial<> here is a TypeScript limitation
  // (Object.fromEntries can't statically prove a Record's key coverage
  // from its input array), not a real possibility of a partial result.
  if (assets.length === 0) return {}

  const entries = await Promise.all(
    assets.map(async (asset): Promise<[AssetSymbol, PricePoint[]]> => {
      const coinId = COIN_ID[asset]
      const url = `${baseUrl}/coins/${coinId}/market_chart?vs_currency=usd&days=1`
      const raw = await fetchJson(url, fetchImpl, apiKey)
      const chart = parseOrThrow(CoinGeckoMarketChartResponse, raw, `/coins/${coinId}/market_chart?days=1`)
      const points = chart.prices.map(([ts, price]) => ({ timestamp: msToIso(ts), price }))
      return [asset, points]
    }),
  )

  return Object.fromEntries(entries)
}

// --- Aggressive strategy intraday feed (v3-jev-intraday-30m) -------------
//
// The additive data cost Aggressive pays on top of Balanced's own
// getMarketData — 2 more requests per asset (1+5N total for N assets vs
// getMarketData's 1+3N), never a replacement: Aggressive still calls
// getMarketData too, so the 50DMA stays available as context (see
// strategy/aggressive's own module comments — never a gate for this
// profile). Reuses fetchJson/parseOrThrow/COIN_ID/CoinGeckoOhlcResponse/
// CoinGeckoMarketChartResponse unchanged — no new provider, no new schema
// beyond what this file already validates.
//
// /ohlc?days=1 -> 48 x 30-minute TRUE OHLC (confirmed live,
// trading-domain-contract.md §5) — the sole ATR source for this profile.
// Never the 4-hourly /ohlc?days=30 candles getMarketData uses: a 4h ATR
// is incoherent at a 15-60 minute holding horizon.
//
// /market_chart?days=1 -> ~289 x 5-minute spot + volume, the SAME
// response fetchRecentPricePoints above already knows how to fetch for
// the position monitor — except that function only ever kept
// chart.prices and silently discarded chart.total_volumes. Surfacing
// volume here costs nothing extra: same request, same response, just
// reading a field that was already being parsed and thrown away.
// closedPoints(..., 5min) drops the trailing off-grid live point, same
// as getMarketData already does for its own hourly/daily series.
export async function fetchIntradayMarketData(
  assets: AssetSymbol[],
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = BASE_URL,
  apiKey?: string,
): Promise<Partial<Record<AssetSymbol, IntradayMarketData>>> {
  if (assets.length === 0) return {}

  const FIVE_MIN_MS = 5 * 60 * 1000

  const entries = await Promise.all(
    assets.map(async (asset): Promise<[AssetSymbol, IntradayMarketData]> => {
      const coinId = COIN_ID[asset]

      const [ohlcRaw, chartRaw] = await Promise.all([
        fetchJson(`${baseUrl}/coins/${coinId}/ohlc?vs_currency=usd&days=1`, fetchImpl, apiKey),
        fetchJson(`${baseUrl}/coins/${coinId}/market_chart?vs_currency=usd&days=1`, fetchImpl, apiKey),
      ])

      const ohlc = parseOrThrow(CoinGeckoOhlcResponse, ohlcRaw, `/coins/${coinId}/ohlc?days=1`)
      const ohlc30m: OhlcCandle[] = ohlc.map(([ts, open, high, low, close]) => ({
        timestamp: msToIso(ts),
        open,
        high,
        low,
        close,
      }))

      const chart = parseOrThrow(CoinGeckoMarketChartResponse, chartRaw, `/coins/${coinId}/market_chart?days=1`)
      const volumeByTimestamp = new Map(chart.total_volumes.map(([ts, volume]) => [ts, volume]))
      const rawSpotPoints = chart.prices.map(([ts, price]) => ({ timestamp: msToIso(ts), price, volume: volumeByTimestamp.get(ts) ?? 0 }))
      const spot5m: IntradaySpotPoint[] = closedPoints(rawSpotPoints, FIVE_MIN_MS)

      return [asset, { asset, ohlc30m, spot5m }]
    }),
  )

  return Object.fromEntries(entries)
}

// --- Market-quote refresh -----------------------------------------------
//
// The cheapest possible current-price fetch: one /coins/markets call for
// every requested asset, no OHLC/market_chart requests at all — used by
// the market-refresh Edge Function (a separate, trade-incapable process,
// see context/architecture.md § Scheduling) to keep the extension's
// displayed prices current between manual agent runs, without the ~7x
// request cost getMarketData pays for indicator history it doesn't need.
// Standalone, same reasoning as fetchRecentPricePoints above: it returns
// MarketQuote, not NormalizedMarketData, so it doesn't implement
// MarketDataProvider and doesn't belong on the class either.
export async function fetchLatestQuotes(
  assets: AssetSymbol[],
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = BASE_URL,
  apiKey?: string,
): Promise<MarketQuote[]> {
  if (assets.length === 0) return []

  const fetchedAt = new Date().toISOString()
  const markets = await fetchMarketsSummary(assets, fetchImpl, baseUrl, apiKey)

  return assets.map((asset) => {
    const marketEntry = findMarketEntry(asset, markets)
    return parseOrThrow(MarketQuoteSchema, toQuoteFields(asset, marketEntry, fetchedAt), 'quote output')
  })
}
