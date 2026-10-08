// Closed-bar correctness (trading-strategy-v1.md §6: "every rule evaluates
// on completed bars"; §0 defect D1). Live-verified against the real
// CoinGecko API (2026-09-21, all three granularities this project uses),
// not assumed from docs:
//
//   /market_chart (days=1, 30, 120 — 5-min/hourly/daily) ALWAYS appends
//   exactly one extra point after its regular, evenly-spaced historical
//   series: the current live spot price, timestamped at request time
//   rather than on the series' own grid. Confirmed live: the gap between
//   that point and its predecessor was 4.17min (vs a 5min series), 43.8min
//   (vs 60min), and 5.72h (vs 24h) respectively — always shorter than the
//   series' own interval, and the point itself only ~2-3 minutes old
//   regardless of the nominal bucket size. `prices` and `total_volumes`
//   share identical timestamps (confirmed live), so this applies to both.
//
//   /ohlc (the 4-hourly `candles` this project uses for ATR%/7-day-range)
//   does NOT have this problem: live-verified 180 candles at days=30, every
//   single gap exactly 4.0 hours including the last — CoinGecko withholds
//   the in-progress candle from this endpoint entirely, and each returned
//   candle's timestamp is genuinely its own close time (confirmed:
//   `OhlcCandle.timestamp`'s doc comment is correct here, not a defect).
//   `closedPoints` is therefore never applied to `candles`.
//
// This function targets exactly the confirmed defect — a single
// off-grid trailing point on a `/market_chart`-sourced series — rather
// than a generic "now minus bucket duration" calculation, which would be
// guessing at semantics this API doesn't actually have (a spot-price time
// series has no open/close of its own to compute from).

export function closedPoints<T extends { timestamp: string }>(
  points: readonly T[],
  expectedIntervalMs: number,
): T[] {
  if (points.length < 2) return [...points]

  const last = new Date(points[points.length - 1]!.timestamp).getTime()
  const secondLast = new Date(points[points.length - 2]!.timestamp).getTime()
  const lastGapMs = last - secondLast

  // A live/off-grid point's gap from its predecessor is shorter than the
  // series' own regular interval (confirmed live, see above) — drop it.
  // A gap at or above the expected interval means the series already ends
  // on a genuine, fully-elapsed point (e.g. a request landing exactly on
  // a grid boundary), so nothing is dropped.
  if (lastGapMs < expectedIntervalMs) return points.slice(0, -1)
  return [...points]
}

// Plan STRAT-1 P2 (2026-10-08) — a confirmed look-ahead defect
// `closedPoints` alone does not catch. Live-measured against `market_bars`:
// the daily (`1d`) series' most recent row kept advancing by ~15 minutes
// between consecutive agent-cycle runs (05:13:10, 04:58:40, 04:43:30, ...),
// instead of sitting still until a genuine new calendar day closed — 24
// off-grid rows accumulated for one single in-progress day. Root cause:
// CoinGecko's `days=120` daily series intermittently OMITS today's own
// 00:00 point entirely. When it does, the trailing live point's gap from
// YESTERDAY's 00:00 point is `24h + elapsed-today` — at or above DAY_MS —
// so `closedPoints`'s own gap heuristic (correctly designed for the single
// "one extra point, always off-grid, always a short gap" case) concludes
// nothing needs dropping. The live point is then read as "today's close,"
// when it is actually the current spot price — i.e. `regime.dailyClose`
// was the live spot price, not a closed daily close, on exactly the cycles
// where this happens. Confirmed unaffected: the hourly and 5-minute series
// never exhibit this (their trailing point's gap is always short).
//
// This is a SEPARATE, grid-based check — not a gap heuristic — because the
// defect here is specifically "the point doesn't land on its own interval's
// grid," which a gap-from-predecessor calculation cannot detect when the
// gap itself looks superficially large enough to be genuine. Deliberately
// a trim loop, not a single conditional pop: defensive against CoinGecko
// ever returning more than one trailing off-grid point in one response,
// even though live observation shows exactly one per cycle today. Never
// applied to `candles`/`ohlc30m` — same reasoning as `closedPoints` itself
// not applying there (module comment above): those series are genuinely
// close-stamped and complete, confirmed by `reconcileClosedBar`'s own
// ongoing runtime check.
export function gridAlignedTail<T extends { timestamp: string }>(
  points: readonly T[],
  intervalMs: number,
): T[] {
  const result = [...points]
  while (result.length > 0 && new Date(result[result.length - 1]!.timestamp).getTime() % intervalMs !== 0) {
    result.pop()
  }
  return result
}

export interface ClosedBarReconciliationResult {
  ok: boolean
  reason: string | null
}

// Strategy V4 (2026-10-03, plan §5-IMPL review item 3) — the /ohlc
// series' close-time, in-progress-withheld semantics (the module comment
// above) rested on an upstream assumption whose ONLY recorded evidence
// was uniform gap spacing — which cannot actually distinguish a
// close-stamped COMPLETED bar from an open-stamped IN-PROGRESS one (both
// produce perfectly uniform gaps). Live-reconciled 2026-10-02/03 against
// this project's own stored 5m spot series instead: the 30m bar stamped
// 14:30 UTC had open=86551.xx (matching stored spot at 14:00) and
// close=86116.xx (matching stored spot at 14:30) — proving it covers
// 14:00->14:30, i.e. timestamps ARE close times and the in-progress bar
// genuinely IS withheld. This function is the ongoing, cheap runtime
// version of that one-off manual check: both series are already fetched
// every cycle an intraday profile runs (market_bars already fills from
// both), so reconciling costs nothing and would catch an upstream
// semantics change immediately instead of silently repainting every
// detector arm.
//
// Deliberately a WARNING, never a filter and never a hard fail-closed:
// filtering `candles`/`ohlc30m` would now be the WRONG fix (they are
// correctly unfiltered today — coingecko.test.ts's own "candles are
// never passed through closedPoints" test must keep passing), and a
// mis-set tolerance must never be able to halt trading on its own.
export function reconcileClosedBar(
  newestCandle: { timestamp: string; close: number } | undefined,
  spotPoints: readonly { timestamp: string; price: number }[],
  toleranceFraction: number,
): ClosedBarReconciliationResult {
  if (!newestCandle) return { ok: true, reason: null } // nothing to reconcile this cycle
  const matchingSpot = spotPoints.find((p) => p.timestamp === newestCandle.timestamp)
  // No spot point lands on the EXACT same timestamp this cycle (the two
  // series are fetched independently, so their grids can drift apart) —
  // can't check, so don't warn. This is expected on most cycles, not a
  // defect in the check itself.
  if (!matchingSpot) return { ok: true, reason: null }
  const relativeDiff = Math.abs(newestCandle.close - matchingSpot.price) / matchingSpot.price
  if (relativeDiff > toleranceFraction) {
    return {
      ok: false,
      reason: `newest candle at ${newestCandle.timestamp} has close=${newestCandle.close}, but the spot series' point at the same timestamp is ${matchingSpot.price} (${(relativeDiff * 100).toFixed(2)}% apart, tolerance ${(toleranceFraction * 100).toFixed(2)}%) — the close-time/withheld-in-progress-bar assumption this project depends on may no longer hold`,
    }
  }
  return { ok: true, reason: null }
}
