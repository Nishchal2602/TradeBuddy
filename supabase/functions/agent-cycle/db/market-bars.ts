import type { SupabaseClient } from '@supabase/supabase-js'
import type { AssetSymbol, NormalizedMarketData, OhlcCandle } from '../../../../src/shared/market-data/types.ts'
import type { IntradayMarketData, IntradaySpotPoint } from '../strategy/aggressive/types.ts'
import { toIsoZ } from './row-mappers.ts'

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
//
// Provenance fields (CFG-1 Stage 0, 2026-10-06) — added so a future
// replay harness can reconstruct the INFORMATION SET available at time
// t, not just the price path. `closeTime`/`ingestedAt`/`source`/
// `batchId`/`dataVersion` are threaded through from the caller rather
// than computed with a bare Date.now() here, matching this codebase's
// existing clock-injection discipline for pure functions.

export const MARKET_BARS_DATA_VERSION = 'v1'

export type BarTimeframe = '5m' | '30m' | '4h' | '1d'

export interface MarketBarRow {
  asset: AssetSymbol
  timeframe: BarTimeframe
  openTime: string
  // Explicitly named alias of openTime, added 2026-10-06 — openTime has
  // ALWAYS held the bar's CLOSE instant for every series this table
  // stores (verified live, 2026-10-03: a 30m bar stamped 14:30 covers
  // 14:00->14:30; a close-only point's own timestamp already IS its
  // close). openTime is kept as the column name for backward
  // compatibility (it's half the primary key) — closeTime exists so a
  // future reader never has to rediscover this the hard way.
  closeTime: string
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
  // CAVEAT, permanent (CFG-1 Stage 0 finding): this is CoinGecko's
  // `total_volumes` field, which is ROLLING 24-HOUR TRAILING volume
  // resampled at 5-minute intervals — NOT incremental per-interval
  // volume. Verified live 2026-10-06: BTC's series reads ~$25-34
  // BILLION per 5-minute point (24h-scale, not interval-scale), moving
  // only single-digit percent between consecutive samples. No endpoint
  // on CoinGecko's free/Demo tier returns true incremental volume at any
  // intraday granularity — /ohlc never includes volume at all. Never
  // read this as "volume traded in this bar." strategy/aggressive/
  // features.ts's volumeTrend() computing a ratio of two windows of
  // this series is consequently near-meaningless (see CFG-1 plan
  // correction #9, which removes the one live consumer that treated it
  // as real).
  volume: number | null
  isSampled: boolean
  // Provenance — never computed with a bare clock read here; always the
  // caller's own nowIso/runId, so every bar in one write carries the
  // same values and a replay can group by them. ingestedAt/dataVersion
  // are nullable (CFG-1 Stage 2, 2026-10-06, widened for marketBarRowFromDbRow
  // below) ONLY because every pre-Stage-0 row genuinely has NULL here —
  // every write path (barsFrom*) still always supplies a real value, so
  // this widening changes nothing about what gets written.
  source: string
  ingestedAt: string | null
  batchId: string | null
  dataVersion: string | null
}

export interface BarProvenance {
  nowIso: string
  batchId: string | null
  source?: string
}

const DEFAULT_SOURCE = 'coingecko'

export function barsFromOhlcCandles(
  asset: AssetSymbol,
  timeframe: '30m' | '4h',
  candles: readonly OhlcCandle[],
  provenance: BarProvenance,
): MarketBarRow[] {
  return candles.map((c) => ({
    asset,
    timeframe,
    openTime: c.timestamp,
    closeTime: c.timestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: null,
    isSampled: false,
    source: provenance.source ?? DEFAULT_SOURCE,
    ingestedAt: provenance.nowIso,
    batchId: provenance.batchId,
    dataVersion: MARKET_BARS_DATA_VERSION,
  }))
}

export function barsFromCloseSeries(
  asset: AssetSymbol,
  timeframe: '1d',
  closes: readonly { timestamp: string; close: number }[],
  provenance: BarProvenance,
): MarketBarRow[] {
  return closes.map((c) => ({
    asset,
    timeframe,
    openTime: c.timestamp,
    closeTime: c.timestamp,
    open: null,
    high: null,
    low: null,
    close: c.close,
    volume: null,
    isSampled: true,
    source: provenance.source ?? DEFAULT_SOURCE,
    ingestedAt: provenance.nowIso,
    batchId: provenance.batchId,
    dataVersion: MARKET_BARS_DATA_VERSION,
  }))
}

export function barsFromSpotPoints(
  asset: AssetSymbol,
  timeframe: '5m',
  points: readonly IntradaySpotPoint[],
  provenance: BarProvenance,
): MarketBarRow[] {
  return points.map((p) => ({
    asset,
    timeframe,
    openTime: p.timestamp,
    closeTime: p.timestamp,
    open: null,
    high: null,
    low: null,
    close: p.price,
    volume: p.volume,
    isSampled: true,
    source: provenance.source ?? DEFAULT_SOURCE,
    ingestedAt: provenance.nowIso,
    batchId: provenance.batchId,
    dataVersion: MARKET_BARS_DATA_VERSION,
  }))
}

// Called once per asset, every cycle, regardless of profile — `candles`
// and `dailyCloseSeries` are already fetched unconditionally by
// getMarketData (providers/coingecko.ts), so this adds zero new requests.
export function marketBarsFromNormalizedMarketData(data: NormalizedMarketData, provenance: BarProvenance): MarketBarRow[] {
  return [
    ...barsFromOhlcCandles(data.asset, '4h', data.candles, provenance),
    ...barsFromCloseSeries(data.asset, '1d', data.dailyCloseSeries, provenance),
  ]
}

// Called only for an asset with a present IntradayMarketData entry
// (currently: strategyProfile === 'aggressive' | 'intraday_ls' — see
// index.ts's own intradayByAsset comment). Adds zero new requests:
// ohlc30m/spot5m are already fetched by fetchIntradayMarketData whenever
// one of those profiles is active.
export function marketBarsFromIntradayMarketData(intraday: IntradayMarketData, provenance: BarProvenance): MarketBarRow[] {
  return [
    ...barsFromOhlcCandles(intraday.asset, '30m', intraday.ohlc30m, provenance),
    ...barsFromSpotPoints(intraday.asset, '5m', intraday.spot5m, provenance),
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

// CFG-1 Stage 2 (2026-10-06) — the reverse of toDbRow, for the replay
// harness (the first and only reader of this table). Co-located with
// toDbRow rather than split into a separate module, so the one domain
// type and both its transform directions stay in one place. Same
// Number(...)/toIsoZ coercion discipline as db/row-mappers.ts's
// rowToPosition — PostgREST serializes numeric columns as strings and
// timestamptz as "+00:00", neither of which this table is exempt from.
export function marketBarRowFromDbRow(row: Record<string, unknown>): MarketBarRow {
  return {
    asset: row.asset as AssetSymbol,
    timeframe: row.timeframe as BarTimeframe,
    openTime: toIsoZ(row.open_time as string),
    closeTime: toIsoZ(row.close_time as string),
    open: row.open === null ? null : Number(row.open),
    high: row.high === null ? null : Number(row.high),
    low: row.low === null ? null : Number(row.low),
    close: Number(row.close),
    volume: row.volume === null ? null : Number(row.volume),
    isSampled: row.is_sampled as boolean,
    source: row.source as string,
    ingestedAt: row.ingested_at === null ? null : toIsoZ(row.ingested_at as string),
    batchId: row.batch_id as string | null,
    dataVersion: row.data_version as string | null,
  }
}

function toDbRow(row: MarketBarRow) {
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
    is_sampled: row.isSampled,
    source: row.source,
    ingested_at: row.ingestedAt,
    batch_id: row.batchId,
    data_version: row.dataVersion,
  }
}

// One upsert per (asset, timeframe) group present in `rows`, each
// filtered against its own stored max first (filterNewBars above) so a
// steady-state cycle only ever writes the bars genuinely new since the
// last run. A failure here is logged, never thrown — market_bars is a
// side write for future analysis, not a trading action, the same
// non-fatal discipline this file's sibling market_quotes upsert already
// uses in index.ts ("a side write to a display-only table, not a
// trading action").
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
