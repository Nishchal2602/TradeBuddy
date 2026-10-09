// DT-1 (2026-10-09, Stage A frozen, Order-of-Work step 4) — a research-only
// asset identity, deliberately NOT a widening of AssetSymbol.
//
// AssetSymbol (src/shared/market-data/types.ts) is a 4-value compile-time
// enum that feeds ALL_ASSETS -> market-refresh's live CoinGecko ingestion,
// COIN_ID, ASSET_PATTERNS, and asset-universe.test.ts's own pin. Widening
// it to admit ~20 external DT-1 assets would make every one of them
// live-visible to the trading system -- exactly what
// ai-workflow-rules.md's "no new traded asset" rule forbids, and it would
// force inventing a CoinGecko id and an RSS regex for coins the live
// system will never trade, purely to satisfy exhaustive Record types that
// have nothing to do with research.
//
// ResearchSymbol is the UNDERLYING asset id (e.g. 'BTC', 'DOGE', 'BCH',
// 'VET') -- the identity research_contracts.underlying_id resolves a
// Binance exchange symbol (e.g. 'BCCUSDT', 'VENUSDT') to, and the value
// historical_bars.asset is keyed on. The existing four live assets are
// simply research symbols that happen to also be live symbols -- BTC/ETH/
// SUI/AVAX rows already ingested under RESEARCH-1 (2026-10-08) are read
// through the exact same path as any other research symbol, no special
// casing required.
//
// Deliberately a plain string alias, not a nominal/branded type: ANY
// AssetSymbol value is already a valid ResearchSymbol value by
// construction (a live asset's ticker is a perfectly good underlying id),
// so there is nothing to protect against by forcing a cast at that
// direction. The protection this type exists for -- never let a
// ResearchSymbol flow back into AssetSymbol-typed live code untyped -- is
// enforced at the few genuine boundary crossings instead (an explicit,
// commented `as AssetSymbol` cast at each, justified by: the live pure
// functions on the other side of that boundary -- buildCandidateProposal,
// openPosition, closePosition -- never run this field through a runtime
// Zod parse; it is carried through purely as bookkeeping/map-key/string-
// interpolation data, confirmed by grepping each file for `.parse(`/
// `.safeParse(` before relying on this).
export type ResearchSymbol = string
