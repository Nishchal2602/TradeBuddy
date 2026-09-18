import type { AssetSymbol, NormalizedMarketData } from './types.ts'

// The agent cycle depends on this interface only — never on a concrete
// provider. This is the whole point of the adapter boundary (user
// direction, 2026-09-17): swapping CoinGecko for another source later means
// writing one new file that implements this, not touching agent-cycle.
export interface MarketDataProvider {
  // Fetches current spot + enough recent history to compute indicators for
  // each requested asset in one call. Plural (not one-asset-at-a-time) for
  // two reasons: it mirrors NewsProvider.getRecentNews's shape, and it lets
  // an implementation batch whatever its upstream API allows batching
  // (e.g. CoinGecko's /coins/markets takes a comma-separated id list) —
  // callers shouldn't have to loop per-asset to get that.
  //
  // Implementations own their own lookback window sizing
  // (project-overview.md's "~24 recent hourly closes" is a display-layer
  // target, not a fetch parameter here).
  //
  // A partial failure (data for BTC arrived, ETH's request errored) throws
  // rather than returning a partial array — code-standards.md "fail closed
  // for trading decisions": the caller can't safely decide per-asset
  // whether a missing entry means "skip this asset" or "skip the cycle,"
  // so that ambiguity is not allowed to exist. Throws
  // ProviderFetchError / ProviderRateLimitError / ProviderValidationError
  // (src/shared/providers/errors.ts).
  getMarketData(assets: AssetSymbol[]): Promise<NormalizedMarketData[]>
}
