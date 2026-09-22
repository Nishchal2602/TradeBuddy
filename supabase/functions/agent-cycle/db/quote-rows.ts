import type { AssetSymbol, MarketQuote } from '../../../../src/shared/market-data/types.ts'

// Shared domain -> market_quotes row mapping, used by both market-refresh
// (its whole reason to exist) and agent-cycle (which already holds this
// exact data from its own getMarketData call, and upserts it too — see
// the "market_quotes plan" §4: a display quote should reflect what
// CoinGecko actually returned even on a cycle the freshness gate later
// skips, not just what market-refresh happens to have fetched most
// recently). Extracted here, beside row-mappers.ts's own DB-row helpers,
// rather than duplicated in two Edge Functions — same "do not duplicate
// business logic" reasoning as that file.
//
// Plain TS interfaces, not Zod: this is data WE construct and send, not
// untrusted input to validate — same asymmetry as model/payload.ts's
// ModelCallPayload/VetoCallPayload.
//
// The two row shapes are deliberately DIFFERENT sets of keys, not one
// shape with optional fields: PostgREST's upsert (Prefer:
// resolution=merge-duplicates) only touches the columns actually present
// in the payload — an already-relied-on behavior in this codebase (see
// index.ts's persistNews). A refresh failure must never overwrite a good
// price with garbage, so its row omits price/change/provider/
// data_as_of/fetched_at entirely rather than passing them as null/
// unchanged — there is no way to "send nothing" for a field that's
// present in the object at all.

export interface MarketQuoteRow {
  asset: AssetSymbol
  price: number
  change_1h_pct: number | null
  change_24h_pct: number | null
  change_7d_pct: number | null
  provider: string
  data_as_of: string
  fetched_at: string
  // Success clears any prior failure — a quote that just refreshed
  // cleanly is no longer in an error state, regardless of what the last
  // attempt before it did.
  last_refresh_error: null
  last_refresh_error_at: null
}

export interface MarketQuoteErrorRow {
  asset: AssetSymbol
  last_refresh_error: string
  last_refresh_error_at: string
}

export function toQuoteRow(quote: MarketQuote): MarketQuoteRow {
  return {
    asset: quote.asset,
    price: quote.price,
    change_1h_pct: quote.change1hPct,
    change_24h_pct: quote.change24hPct,
    change_7d_pct: quote.change7dPct,
    provider: quote.provider,
    data_as_of: quote.dataAsOf,
    fetched_at: quote.fetchedAt,
    last_refresh_error: null,
    last_refresh_error_at: null,
  }
}

// fetchLatestQuotes (coingecko.ts) is all-or-nothing per call — one
// /coins/markets request either returns every requested asset or throws
// — so a failure needs an error row for every asset that was requested,
// not just one. Plural to match that reality, not a stylistic choice.
export function toRefreshErrorRows(assets: AssetSymbol[], errorMessage: string, nowIso: string): MarketQuoteErrorRow[] {
  return assets.map((asset) => ({
    asset,
    last_refresh_error: errorMessage,
    last_refresh_error_at: nowIso,
  }))
}
