import { supabase } from '@/supabase'
import type { AssetSymbol } from '@/shared/market-data/types.ts'

// Cross-feature read-only queries — both Home and Decision-detail need
// "latest price per asset," and Decision-detail additionally needs to
// resolve a decision's cited news ids, the same way Home's latest-
// decision card does. Factored out here rather than duplicated a second
// time once that second real consumer existed (moved out of
// features/home/queries.ts, UI Step 3).

export interface LatestMarketPrice {
  asset: AssetSymbol
  price: number
  change24hPct: number | null
  dataAsOf: string
}

/** Latest known price per asset, from market_quotes — a genuinely live
 * quote (not architecture.md's excluded streaming feed: it's a ~5-minute
 * poll, refreshed independently of the decision cycle by market-refresh,
 * see the "market_quotes plan," 2026-09-21). Previously read
 * market_snapshots (the decision cycle's own per-run indicator snapshot,
 * frozen between manual "Run agent" clicks) with an order+limit+dedup
 * loop working around that table having no per-asset "latest" shape;
 * market_quotes has exactly one row per asset (its primary key), so a
 * plain filtered select replaces all of that. */
export async function fetchLatestMarketPrices(assets: AssetSymbol[]): Promise<Map<AssetSymbol, LatestMarketPrice>> {
  const { data, error } = await supabase
    .from('market_quotes')
    .select('asset, price, change_24h_pct, data_as_of')
    .in('asset', assets)
  if (error) throw new Error(`could not load market prices: ${error.message}`)

  const byAsset = new Map<AssetSymbol, LatestMarketPrice>()
  for (const row of data ?? []) {
    byAsset.set(row.asset, {
      asset: row.asset,
      price: Number(row.price),
      change24hPct: row.change_24h_pct === null ? null : Number(row.change_24h_pct),
      dataAsOf: row.data_as_of,
    })
  }
  return byAsset
}

export interface NewsHeadline {
  headline: string
  source: string
  url: string | null
}

/** Resolves NEWS-type reasons' newsId references to their real headline —
 * ui-context.md "render only persisted decision reasons and references,"
 * and the raw reason text sometimes only embeds the bare UUID (a live,
 * observed model-output quirk, not something this file works around by
 * rewriting the model's own text — this is additive evidence display,
 * not a correction). */
export async function fetchNewsHeadlines(newsIds: string[]): Promise<Map<string, NewsHeadline>> {
  if (newsIds.length === 0) return new Map()
  const { data, error } = await supabase.from('news_items').select('id, headline, source, url').in('id', newsIds)
  if (error) throw new Error(`could not load cited news: ${error.message}`)
  return new Map((data ?? []).map((row) => [row.id, { headline: row.headline, source: row.source, url: row.url }]))
}
