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
