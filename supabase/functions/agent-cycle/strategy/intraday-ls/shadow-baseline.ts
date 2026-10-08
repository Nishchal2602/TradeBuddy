import type { Direction } from './detectors.ts'

export interface BaselineOpportunity {
  direction: Direction
  triggerBarTs: string
  triggerBarClose: number
}

// STRAT-1 P3 (2026-10-08) — one long + one short baseline row per asset
// per cycle (plan's "random-entry baseline", correction E6: "shadows need
// a baseline — 'breakout_short won 38%' means nothing on its own"). No
// detector, no signal: these exist purely so a real arm's win rate has
// something to be compared against. Keyed by the most-recently-closed 30m
// bar's own timestamp, so repeated 15-minute cycles observing the
// identical bar dedup to one row via shadow_candidates' own unique index
// — this function just supplies a STABLE key, it does not itself dedup.
export function buildBaselineOpportunities(bars30m: readonly { timestamp: string; close: number }[]): BaselineOpportunity[] {
  const last = bars30m[bars30m.length - 1]
  if (!last) return []
  return [
    { direction: 'long', triggerBarTs: last.timestamp, triggerBarClose: last.close },
    { direction: 'short', triggerBarTs: last.timestamp, triggerBarClose: last.close },
  ]
}
