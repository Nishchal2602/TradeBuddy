import type { SupabaseClient } from '@supabase/supabase-js'
import type { AssetSymbol, NormalizedMarketData, OhlcCandle } from '../../../../src/shared/market-data/types.ts'
import type { IntradayMarketData, IntradaySpotPoint } from '../strategy/aggressive/types.ts'

// market_bars (Strategy V4 Phase 0.6, 2026-10-01) — persistent price
// history, filled entirely from data agent-cycle ALREADY fetches every
// cycle (candles -> 4h, dailyCloseSeries -> 1d, ohlc30m -> 30m, spot5m ->
// 5m). Zero extra CoinGecko requests. This is the foundation the shadow
// labeler and any future backtest/replay harness depend on — no history
// exists before this table started filling, so everything before this
// migration is permanently unlabelable (plan §1's own note).
//
// Pure mapping/filtering functions below, independently testable with
// fixtures alone — same split as every other DB-adjacent module in this
// codebase (db/row-mappers.ts, db/quote-rows.ts). Only upsertMarketBars
// at the bottom touches Supabase.

export type BarTimeframe = '5m' | '30m' | '4h' | '1d'

export interface MarketBarRow {
  asset: AssetSymbol
  timeframe: BarTimeframe
  openTime: string
  // True OHLC (candles/ohlc30m) -> all three populated, isSampled=false.
  // Close-only series (dailyCloseSeries/spot5m) -> all three null,
  // isSampled=true — a close-only point has no true high/low to report,
  // matching strategy/aggressive/features.ts's own `sampled...` naming
  // discipline for exactly the same reason (never mistaken for a true
  // intraday extremum downstream).
  open: number | null
  high: number | null
  low: number | null
  close: number
  volume: number | null
  isSampled: boolean
}

export function barsFromOhlcCandles(asset: AssetSymbol, timeframe: '30m' | '4h', candles: readonly OhlcCandle[]): MarketBarRow[] {
  return candles.map((c) => ({
    asset,
    timeframe,
    openTime: c.timestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: null,
    isSampled: false,
  }))
}

export function barsFromCloseSeries(asset: AssetSymbol, timeframe: '1d', closes: readonly { timestamp: string; close: number }[]): MarketBarRow[] {
  return closes.map((c) => ({
    asset,
    timeframe,
    openTime: c.timestamp,
    open: null,
    high: null,
    low: null,
    close: c.close,
    volume: null,
    isSampled: true,
  }))
}

export function barsFromSpotPoints(asset: AssetSymbol, timeframe: '5m', points: readonly IntradaySpotPoint[]): MarketBarRow[] {
  return points.map((p) => ({
    asset,
    timeframe,
    openTime: p.timestamp,
    open: null,
    high: null,
    low: null,
    close: p.price,
    volume: p.volume,
    isSampled: true,
  }))
}

// Called once per asset, every cycle, regardless of profile — `candles`
// and `dailyCloseSeries` are already fetched unconditionally by
// getMarketData (providers/coingecko.ts), so this adds zero new requests.
export function marketBarsFromNormalizedMarketData(data: NormalizedMarketData): MarketBarRow[] {
  return [
    ...barsFromOhlcCandles(data.asset, '4h', data.candles),
    ...barsFromCloseSeries(data.asset, '1d', data.dailyCloseSeries),
  ]
}

// Called only for an asset with a present IntradayMarketData entry
// (currently: strategyProfile === 'aggressive' only — see index.ts's own
// intradayByAsset comment). Adds zero new requests: ohlc30m/spot5m are
// already fetched by fetchIntradayMarketData whenever that profile is
// active.
export function marketBarsFromIntradayMarketData(intraday: IntradayMarketData): MarketBarRow[] {
  return [
    ...barsFromOhlcCandles(intraday.asset, '30m', intraday.ohlc30m),
    ...barsFromSpotPoints(intraday.asset, '5m', intraday.spot5m),
  ]
}

// Write-volume discipline (migration plan §7's own comment: "writing
// only bars newer than the stored max") — a steady-state cycle re-fetches
// the SAME ~180-bar/~289-point windows every time (CoinGecko has no
// since/after parameter), so without this filter every cycle would
// re-upsert the entire window instead of just the handful of bars
// genuinely new since the last run. Pure and independently testable; the
// DB round-trip to learn the stored max lives in upsertMarketBars below.
export function filterNewBars(rows: readonly MarketBarRow[], storedMaxOpenTime: string | null): MarketBarRow[] {
  if (storedMaxOpenTime === null) return [...rows]
  const maxMs = new Date(storedMaxOpenTime).getTime()
  return rows.filter((r) => new Date(r.openTime).getTime() > maxMs)
}

function toDbRow(row: MarketBarRow) {
  return {
    asset: row.asset,
    timeframe: row.timeframe,
    open_time: row.openTime,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    is_sampled: row.isSampled,
  }
}

// One upsert per (asset, timeframe) group present in `rows`, each
// filtered against its own stored max first (filterNewBars above) so a
// steady-state cycle only ever writes the bars genuinely new since the
// last run. A failure here is logged, never thrown — market_bars is a
// side write for future analysis, not a trading action, the same
// non-fatal discipline this file's sibling market_quotes upsert already
// uses in index.ts ("a side write to a display-only table, not a trading
// action").
export async function upsertMarketBars(supabase: SupabaseClient, rows: readonly MarketBarRow[]): Promise<void> {
  const byKey = new Map<string, MarketBarRow[]>()
  for (const row of rows) {
    const key = `${row.asset}:${row.timeframe}`
    const group = byKey.get(key)
    if (group) group.push(row)
    else byKey.set(key, [row])
  }

  for (const group of byKey.values()) {
    const { asset, timeframe } = group[0]!
    const { data, error: readError } = await supabase
      .from('market_bars')
      .select('open_time')
      .eq('asset', asset)
      .eq('timeframe', timeframe)
      .order('open_time', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (readError) {
      console.error(`upsertMarketBars: could not read stored max open_time for ${asset}/${timeframe}: ${readError.message}`)
      continue
    }

    const storedMaxOpenTime: string | null = data?.open_time ?? null
    const newRows = filterNewBars(group, storedMaxOpenTime)
    if (newRows.length === 0) continue

    const { error: upsertError } = await supabase
      .from('market_bars')
      .upsert(newRows.map(toDbRow), { onConflict: 'asset,timeframe,open_time' })
    if (upsertError) {
      console.error(`upsertMarketBars: could not upsert ${newRows.length} ${asset}/${timeframe} bar(s): ${upsertError.message}`)
    }
  }
}
