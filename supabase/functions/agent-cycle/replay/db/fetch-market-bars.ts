import type { SupabaseClient } from '@supabase/supabase-js'
import type { AssetSymbol } from '../../../../../src/shared/market-data/types.ts'
import { marketBarRowFromDbRow } from '../../db/market-bars.ts'
import type { MarketBarRow } from '../../db/market-bars.ts'

// CFG-1 Stage 2 (2026-10-06) — the ONE impure shell for market-bars-reader.ts's
// pure assembleAsOfCycle. A plain range select, no logic — mirrors
// db/market-bars.ts's own upsertMarketBars (the one function in that
// file that touches Supabase at all). Pulls the FULL range once per
// asset rather than per-cycle, so the caller can assemble many cycle
// timestamps from one fetch instead of re-querying per row.
export async function fetchMarketBarsInRange(
  supabase: SupabaseClient,
  asset: AssetSymbol,
  fromIso: string,
  toIso: string,
): Promise<MarketBarRow[]> {
  const { data, error } = await supabase
    .from('market_bars')
    .select('*')
    .eq('asset', asset)
    .gte('close_time', fromIso)
    .lte('close_time', toIso)
  if (error) throw new Error(`fetchMarketBarsInRange: could not read market_bars for ${asset}: ${error.message}`)
  return (data ?? []).map(marketBarRowFromDbRow)
}
