import type { SupabaseClient } from '@supabase/supabase-js'
import type { HistoricalTimeframe } from '../../providers/binance.ts'
import type { ResearchSymbol } from '../types.ts'
import type { HistoricalBarRow } from './historical-bars.ts'
import type { HistoricalFundingRateRow } from './historical-funding.ts'

// RESEARCH-1 (2026-10-08, stage R2) — the one impure read this engine
// needs per (asset, timeframe): everything in range, oldest -> newest.
// Mirrors replay/db/fetch-market-bars.ts's own pure/impure split (the
// ONLY impure operation is the network round-trip; shaping is elsewhere).
// Paginated via Supabase's own range() — a multi-year 30m series can
// exceed PostgREST's default 1000-row response cap.

const PAGE_SIZE = 1000

export async function fetchHistoricalBarsInRange(
  supabase: SupabaseClient,
  asset: ResearchSymbol,
  timeframe: HistoricalTimeframe,
  fromIso: string,
  toIso: string,
): Promise<HistoricalBarRow[]> {
  const rows: HistoricalBarRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('historical_bars')
      .select('asset, timeframe, open_time, close_time, open, high, low, close, volume, quote_volume')
      .eq('asset', asset)
      .eq('timeframe', timeframe)
      .gte('open_time', fromIso)
      .lte('open_time', toIso)
      .order('open_time', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`fetchHistoricalBarsInRange: ${error.message}`)
    if (!data || data.length === 0) break
    for (const r of data) {
      rows.push({
        asset: r.asset,
        timeframe: r.timeframe,
        openTime: new Date(r.open_time).toISOString(),
        closeTime: new Date(r.close_time).toISOString(),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
        quoteVolume: r.quote_volume === null ? Number.NaN : Number(r.quote_volume),
      })
    }
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return rows
}

export async function fetchHistoricalFundingRatesInRange(
  supabase: SupabaseClient,
  asset: ResearchSymbol,
  fromIso: string,
  toIso: string,
): Promise<HistoricalFundingRateRow[]> {
  const rows: HistoricalFundingRateRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('historical_funding_rates')
      .select('asset, funding_time, funding_rate, mark_price')
      .eq('asset', asset)
      .gte('funding_time', fromIso)
      .lte('funding_time', toIso)
      .order('funding_time', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`fetchHistoricalFundingRatesInRange: ${error.message}`)
    if (!data || data.length === 0) break
    for (const r of data) {
      rows.push({ asset: r.asset, fundingTime: new Date(r.funding_time).toISOString(), fundingRate: Number(r.funding_rate), markPrice: Number(r.mark_price) })
    }
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return rows
}
