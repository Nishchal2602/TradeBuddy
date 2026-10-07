import type { SupabaseClient } from '@supabase/supabase-js'
import type { AssetSymbol, NormalizedMarketData } from '../../../../src/shared/market-data/types.ts'
import type { NormalizedNewsItem } from '../../../../src/shared/news/types.ts'
import type { PersistedNewsItem } from '../cycle/build-context.ts'
import type { IntradayMarketData } from '../strategy/aggressive/types.ts'

// EXP-1 Stage E3 (2026-10-07) — the shared payload one market_ticks row
// carries, written ONCE by cycle-dispatcher (per tick) and read by every
// account's own agent-cycle invocation for that tick. This is what makes
// the "one fetch, shared by every due account" cost-flatness property
// real rather than aspirational — see the plan's own "direct answer to
// does this increase CoinGecko/news cost" section.
//
// Deliberately the VERBATIM fetched shape, never a reconstruction from
// market_bars: CFG-1 Stage 2's own live-input inventory proved
// market_bars cannot reproduce the hourly closeSeries/volumeSeries (no
// 1h timeframe exists) nor the live spot price. marketData/intradayByAsset
// here are fetched for the UNION of every due account's own asset
// subset this tick — an individual account's cycle filters down to just
// its own effective assets when consuming this payload (see index.ts's
// own marketTickId branch), never assumes the payload is already scoped
// to it alone.
//
// News is persisted (news_items, by external_id) exactly ONCE by the
// dispatcher, not per-account — persistedNewsByExternalId carries the
// REAL, already-upserted rows (with their genuine DB ids), so every
// account's own cycle looks news up here rather than re-persisting the
// identical items N times.
export interface MarketTickPayload {
  marketData: NormalizedMarketData[]
  intradayByAsset: Partial<Record<AssetSymbol, IntradayMarketData>>
  rawNews: NormalizedNewsItem[]
  persistedNewsByExternalId: Record<string, PersistedNewsItem>
}

export interface LoadedMarketTick {
  id: string
  logicalTickAt: string
  payload: MarketTickPayload
}

// Throws on anything other than a genuinely ready tick — an agent-cycle
// invocation must never silently proceed on a half-written or failed
// fetch (market_ticks_ready_has_payload's own DB-level guarantee is the
// backstop; this is the application-level fail-closed check in front of
// it).
export async function loadMarketTick(supabase: SupabaseClient, marketTickId: string): Promise<LoadedMarketTick> {
  const { data, error } = await supabase
    .from('market_ticks')
    .select('id, logical_tick_at, payload, status')
    .eq('id', marketTickId)
    .single()
  if (error || !data) throw new Error(`could not load market_ticks row ${marketTickId}: ${error?.message}`)
  if (data.status !== 'ready') throw new Error(`market_ticks row ${marketTickId} is not ready (status=${data.status}) — refusing to decide against incomplete market data`)
  if (!data.payload) throw new Error(`market_ticks row ${marketTickId} is ready but has no payload — should be unreachable (market_ticks_ready_has_payload)`)

  return { id: data.id, logicalTickAt: data.logical_tick_at, payload: data.payload as MarketTickPayload }
}
