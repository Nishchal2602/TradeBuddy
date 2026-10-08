import type { StatsNavPoint } from './stats.ts'

// DT-1 plan, Phase P0 (2026-10-08) — trial registry Sharpes must be
// cadence-comparable before they are pooled into a variance (§6.6 of the
// DT-1 plan). The registry mixes R4's twelve 30-minute V4 trials with its
// one daily baseline trial; per-period Sharpes from different cadences
// are not in the same units, so taking a variance across them as-is would
// mix units and produce a meaningless SR0 inside deflatedSharpeRatio.
//
// This resamples ANY nav series — 30-minute, daily, or otherwise — down
// to one NAV point per UTC calendar day (the last tick observed that
// day), so every trial's Sharpe can be computed on a common daily basis
// regardless of its native cadence.

function utcDayKey(iso: string): string {
  return iso.slice(0, 10) // 'YYYY-MM-DD' in UTC, since every timestamp in this project is already UTC ISO-8601
}

// Keeps the LAST tick observed within each UTC calendar day (standard
// close-of-day resampling) — navSeries is assumed already sorted
// ascending by timestamp, matching every producer in this codebase
// (backtest-engine.ts, baseline-daily-trend.ts both push ticks in
// chronological order).
export function resampleNavToDailyCloseUtc(navSeries: readonly StatsNavPoint[]): StatsNavPoint[] {
  const byDay = new Map<string, StatsNavPoint>()
  for (const point of navSeries) {
    byDay.set(utcDayKey(point.timestamp), point) // last write per key wins -> last tick of the day
  }
  return [...byDay.values()]
}
