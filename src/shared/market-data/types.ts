import { z } from 'zod'

// V0 asset universe (architecture.md, progress-tracker.md). Adding an asset
// is a context-file change, not just a type change — keep this the single
// place the union is spelled out.
export const AssetSymbol = z.enum(['BTC', 'ETH'])
export type AssetSymbol = z.infer<typeof AssetSymbol>

// One true OHLC candle. `timestamp` is the candle's close time, UTC ISO 8601
// — never a Date object, so this survives JSON round-trips (Postgres JSONB,
// fetch payloads) without a revival step.
export const OhlcCandle = z.object({
  timestamp: z.string().datetime(),
  open: z.number().positive(),
  high: z.number().positive(),
  low: z.number().positive(),
  close: z.number().positive(),
})
export type OhlcCandle = z.infer<typeof OhlcCandle>

export const VolumePoint = z.object({
  timestamp: z.string().datetime(),
  volume: z.number().nonnegative(),
})
export type VolumePoint = z.infer<typeof VolumePoint>

// What a MarketDataProvider returns for one asset. Field names deliberately
// mirror the `market_snapshots` columns (supabase/migrations/..._initial_
// schema.sql) so the future persistence step is a near-direct map, not a
// translation layer — see progress-tracker.md Unit 3 notes for why.
//
// This is NOT the full market_snapshots row: `indicators` and `recent_closes`
// are computed by the deterministic-indicators unit (Next Up #3) from
// `candles` below, not supplied by the provider.
export const NormalizedMarketData = z.object({
  asset: AssetSymbol,

  // Which adapter produced this (e.g. "coingecko") — maps to
  // market_snapshots.provider. A plain string, not an enum: the whole point
  // of this interface is that new providers don't require a type change
  // here.
  provider: z.string().min(1),

  // The provider's own claimed freshness for this data (e.g. CoinGecko's
  // `last_updated`) — maps to market_snapshots.data_as_of. This is what
  // staleness checks (invariant 6) compare against, NOT `fetchedAt` below:
  // a 200 response can still carry stale upstream data.
  dataAsOf: z.string().datetime(),

  // When this process made the fetch. Diagnostic only — ingested_at on the
  // DB row is stamped by Postgres' own `now()` default at insert time, not
  // threaded through from here.
  fetchedAt: z.string().datetime(),

  price: z.number().positive(),
  change1hPct: z.number().nullable(),
  change24hPct: z.number().nullable(),
  change7dPct: z.number().nullable(),

  // Ordered oldest -> newest. True OHLC (has real highs/lows), used for ATR
  // and 7-day-high/low. Coarser than `closeSeries` on the free CoinGecko
  // tier (see coingecko.ts) — that asymmetry is deliberate, not a bug.
  candles: z.array(OhlcCandle),

  // Ordered oldest -> newest, close-price-only series (no high/low) —
  // separate from `candles` because the provider may source it from a
  // different, finer-grained endpoint. Feeds RSI/EMA/MACD and the ~24-point
  // "recent closes" shape context (project-overview.md § Market and News
  // Intelligence); NOT a substitute for `candles` since it has no
  // high/low for ATR.
  closeSeries: z.array(z.object({
    timestamp: z.string().datetime(),
    close: z.number().positive(),
  })),

  volumeSeries: z.array(VolumePoint),
})
export type NormalizedMarketData = z.infer<typeof NormalizedMarketData>
