import type { AssetSymbol, VolumePoint } from '../../../../src/shared/market-data/types.ts'
import type { HistoricalBarRow } from './db/historical-bars.ts'
import type { HistoricalMarketSnapshot } from './historical-detect.ts'

// RESEARCH-1 (2026-10-08, stage R2) — the historical equivalent of
// replay/market-bars-reader.ts's assembleAsOfCycle, deliberately much
// simpler: every historical bar is unambiguously known by its own
// close_time alone, with no live-cycle timing uncertainty to model (see
// RESEARCH-1's own plan text on why this is a SEPARATE module from that
// one, not a reuse — the point-in-time ingested_at confirming-write logic
// solves a problem bulk historical data does not have).
//
// `bars` is expected to hold ALL FOUR timeframes for one asset, already
// fetched in full by the caller (db/fetch-historical-bars.ts) — this
// function does no I/O and is a pure filter + map.

function byCloseTimeAscending(a: HistoricalBarRow, b: HistoricalBarRow): number {
  return new Date(a.closeTime).getTime() - new Date(b.closeTime).getTime()
}

function visibleAsOf(bars: readonly HistoricalBarRow[], timeframe: string, cutoffMs: number): HistoricalBarRow[] {
  return bars
    .filter((b) => b.timeframe === timeframe && new Date(b.closeTime).getTime() <= cutoffMs)
    .sort(byCloseTimeAscending)
}

export function assembleSnapshotAsOf(asset: AssetSymbol, bars: readonly HistoricalBarRow[], asOfIso: string): HistoricalMarketSnapshot {
  const cutoffMs = new Date(asOfIso).getTime()
  const forAsset = bars.filter((b) => b.asset === asset)
  const daily = visibleAsOf(forAsset, '1d', cutoffMs)
  const fourH = visibleAsOf(forAsset, '4h', cutoffMs)
  const hourly = visibleAsOf(forAsset, '1h', cutoffMs)
  const thirtyM = visibleAsOf(forAsset, '30m', cutoffMs)

  const latest30m = thirtyM[thirtyM.length - 1]

  return {
    asset,
    dailyCloses: daily.map((b) => ({ timestamp: b.closeTime, close: b.close })),
    h4Candles: fourH.map((b) => ({ timestamp: b.closeTime, open: b.open, high: b.high, low: b.low, close: b.close })),
    hourlyCloses: hourly.map((b) => ({ timestamp: b.closeTime, close: b.close })),
    hourlyVolumes: hourly.map((b): VolumePoint => ({ timestamp: b.closeTime, volume: b.volume })),
    bars30m: thirtyM.map((b) => ({ timestamp: b.closeTime, open: b.open, high: b.high, low: b.low, close: b.close })),
    volumes30m: thirtyM.map((b) => b.volume),
    price: latest30m?.close ?? 0,
    asOfIso,
  }
}
