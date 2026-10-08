import type { SupabaseClient } from '@supabase/supabase-js'
import type { AssetSymbol } from '../../../../../src/shared/market-data/types.ts'
import type { HistoricalKline, HistoricalTimeframe } from '../../providers/binance.ts'

// RESEARCH-1 (2026-10-08) — same pure-row-shaping / impure-write split as
// db/market-bars.ts, for the SEPARATE historical_bars table (never
// market_bars — see the migration's own comment on why).

export interface HistoricalBarRow extends HistoricalKline {
  asset: AssetSymbol
  timeframe: HistoricalTimeframe
}

function toDbRow(row: HistoricalBarRow) {
  return {
    asset: row.asset,
    timeframe: row.timeframe,
    open_time: row.openTime,
    close_time: row.closeTime,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    source: 'binance',
  }
}

export function historicalBarRowFromKline(asset: AssetSymbol, timeframe: HistoricalTimeframe, kline: HistoricalKline): HistoricalBarRow {
  return { asset, timeframe, ...kline }
}

export async function upsertHistoricalBars(supabase: SupabaseClient, rows: readonly HistoricalBarRow[]): Promise<void> {
  if (rows.length === 0) return
  const { error } = await supabase.from('historical_bars').upsert(rows.map(toDbRow), { onConflict: 'asset,timeframe,open_time' })
  if (error) throw new Error(`upsertHistoricalBars: ${error.message}`)
}

// Resumable ingestion — the stored max open_time for (asset, timeframe),
// or null if nothing has been ingested yet (start from the beginning).
export async function fetchStoredMaxOpenTime(supabase: SupabaseClient, asset: AssetSymbol, timeframe: HistoricalTimeframe): Promise<string | null> {
  const { data, error } = await supabase
    .from('historical_bars')
    .select('open_time')
    .eq('asset', asset)
    .eq('timeframe', timeframe)
    .order('open_time', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`fetchStoredMaxOpenTime: ${error.message}`)
  return data?.open_time ?? null
}

export async function countHistoricalBars(supabase: SupabaseClient, asset: AssetSymbol, timeframe: HistoricalTimeframe): Promise<number> {
  const { count, error } = await supabase
    .from('historical_bars')
    .select('*', { count: 'exact', head: true })
    .eq('asset', asset)
    .eq('timeframe', timeframe)
  if (error) throw new Error(`countHistoricalBars: ${error.message}`)
  return count ?? 0
}
