import type { AssetSymbol, OhlcCandle } from '../../../../../src/shared/market-data/types.ts'

// Aggressive strategy (v3-jev-intraday-30m, 2026-09-23) — its own data
// shapes, kept out of src/shared/market-data/types.ts deliberately:
// NormalizedMarketData is a Zod-validated, dual-runtime, UI-facing schema,
// and nothing here needs any of that (it's consumed only inside
// agent-cycle, by this one strategy). See
// context/specs/trading-strategy-aggressive-v3.md for the full data
// story — CoinGecko has no true 15-minute granularity, so this profile
// runs on 30-minute true OHLC (the sole ATR/detector source) plus
// 5-minute spot+volume (short-horizon context only).

// One 5-minute spot sample. Deliberately NOT reusing
// position-monitor/triggers.ts's PricePoint (which agent-cycle's own
// fetchRecentPricePoints already imports across that boundary) — that
// type has no volume field, and volume is exactly the thing this profile
// needs that the monitor's use case never did. `total_volumes` shares
// identical timestamps with `prices` in the same /market_chart response
// (closed-bars.ts's own live-verified finding), so pairing them here is
// a zero-extra-request surfacing of data the pipeline already fetches
// and, before this profile existed, silently discarded.
export interface IntradaySpotPoint {
  timestamp: string
  price: number
  volume: number
}

export interface IntradayMarketData {
  asset: AssetSymbol
  // 48 x 30-minute true OHLC, days=1, oldest -> newest. The SOLE ATR
  // source for this profile (never the 4-hourly `candles` Balanced uses —
  // a 4h ATR is incoherent at a 15-60 minute holding horizon, see
  // protection.ts). Already closed by construction, same guarantee
  // OhlcCandle's own doc comment describes for the 4-hourly /ohlc
  // endpoint: CoinGecko withholds the in-progress candle entirely.
  ohlc30m: OhlcCandle[]
  // ~289 x 5-minute spot+volume, days=1, oldest -> newest, with the
  // trailing off-grid live point already dropped via closedPoints(pts,
  // 300_000) — short-horizon PRICE-ACTION CONTEXT only (returns,
  // realized vol, sampled day high/low, volume trend). Never the ATR
  // source: spot sampling has no real high/low, so an ATR built from it
  // would understate true volatility and produce stops tighter than
  // actually justified.
  spot5m: IntradaySpotPoint[]
}
