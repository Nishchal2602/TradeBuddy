import type { SupabaseClient } from '@supabase/supabase-js'
import type { HistoricalFundingRate } from '../../providers/binance.ts'
import type { ResearchSymbol } from '../types.ts'

export interface HistoricalFundingRateRow extends HistoricalFundingRate {
  asset: ResearchSymbol
}

function toDbRow(row: HistoricalFundingRateRow) {
  return {
    asset: row.asset,
    funding_time: row.fundingTime,
    funding_rate: row.fundingRate,
    mark_price: row.markPrice,
    source: 'binance',
  }
}

export async function upsertHistoricalFundingRates(supabase: SupabaseClient, rows: readonly HistoricalFundingRateRow[]): Promise<void> {
  if (rows.length === 0) return
  const { error } = await supabase.from('historical_funding_rates').upsert(rows.map(toDbRow), { onConflict: 'asset,funding_time' })
  if (error) throw new Error(`upsertHistoricalFundingRates: ${error.message}`)
}

export async function fetchStoredMaxFundingTime(supabase: SupabaseClient, asset: ResearchSymbol): Promise<string | null> {
  const { data, error } = await supabase
    .from('historical_funding_rates')
    .select('funding_time')
    .eq('asset', asset)
    .order('funding_time', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`fetchStoredMaxFundingTime: ${error.message}`)
  return data?.funding_time ?? null
}

export async function countHistoricalFundingRates(supabase: SupabaseClient, asset: ResearchSymbol): Promise<number> {
  const { count, error } = await supabase.from('historical_funding_rates').select('*', { count: 'exact', head: true }).eq('asset', asset)
  if (error) throw new Error(`countHistoricalFundingRates: ${error.message}`)
  return count ?? 0
}
