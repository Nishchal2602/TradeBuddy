import type { OhlcCandle } from '../../../../../src/shared/market-data/types.ts'
import { InsufficientDataError } from '../../indicators/calculate.ts'

// Aggressive strategy — deterministic OPPORTUNITY DETECTION, not an entry
// thesis. The deterministic layer's job is "detect objectively that an
// actionable opportunity exists"; Jev then judges whether it warrants
// action (see model/jev's entry-quality question). Jev can still never
// invent an entry where no detector fired — the non-negotiable rule
// ("the model never originates a trade or chooses its direction") holds
// exactly, the same way it does for Balanced's veto-only OPEN_LONG path.
//
// Both detectors are EDGE-TRIGGERED: the predicate must be FALSE on the
// prior closed bar and TRUE on the current one. A condition that merely
// REMAINS true fires nothing. This is the actual mechanism that
// guarantees "fire once" (migration plan §3/§6) — including the case
// where Jev declines an opportunity and the asset stays FLAT, which a
// purely state-based "no candidate since the last position event" rule
// alone would not catch (a declined breakout that is still true on the
// next bar must not re-fire merely because the position event predates
// it).
//
// All parameters below (12-bar minimum, 8-bar lookback, 4-bar recency,
// 0.5 midpoint) are PRE-REGISTERED AND FROZEN before any run, per the
// anti-overfitting protocol at trading-strategy-v1.md §23 ("we can
// afford almost no configuration search"). Not to be tuned on H6's
// results without declaring a new profile version (V3.1) — see
// context/specs/trading-strategy-aggressive-v3.md.

export type OpportunityKind = 'MOMENTUM_BREAKOUT' | 'PULLBACK_CONTINUATION'

export interface OpportunitySignal {
  kind: OpportunityKind
  // Close timestamp of the closed 30m bar that triggered detection — the
  // lifecycle key strategy/registry.ts compares against this asset's most
  // recent position event (see cycle/collect-candidates.ts's consumer:
  // a candidate is only ever built when this is strictly newer than
  // opened_at/closed_at).
  detectedAtBarTs: string
}

const MIN_BARS = 12
const LOOKBACK_BARS = 8
const RECENCY_BARS = 4
const PULLBACK_MIDPOINT = 0.5

// --- MOMENTUM_BREAKOUT -------------------------------------------------
//
// H8 = max(high) over the 8 bars strictly before `current` (the array's
// own last element). Fires when current.close exceeds that 8-bar high.
// Operates on whatever slice it's given — the edge-trigger wrapper below
// calls this twice, once on the full window and once with the last bar
// dropped, so this function itself must stay a pure function of "the
// last element is current, everything else is history."
function testMomentumBreakout(bars: readonly OhlcCandle[]): boolean {
  const n = bars.length
  if (n < LOOKBACK_BARS + 1) return false
  const current = bars[n - 1]!
  const priorEight = bars.slice(n - 1 - LOOKBACK_BARS, n - 1)
  const h8 = Math.max(...priorEight.map((b) => b.high))
  return current.close > h8
}

// --- PULLBACK_CONTINUATION ----------------------------------------------
//
// Frozen mechanical definition — no interpretation left for a future
// reader:
//   H     = max(high) over the 8 bars strictly before `current` (wick
//           high, same window testMomentumBreakout uses)
//   Hidx  = index (within that same full slice) of the bar containing H
//   require Hidx is within the last 4 CLOSED bars before current, i.e.
//           Hidx >= n-1-RECENCY_BARS ("H made within the last 4 bars")
//   L     = min(low) over bars strictly AFTER the H-bar, up to and
//           including current (wick lows — the retracement leg)
//   require H > L (a real leg exists; H===L would make mid===H===L,
//           a degenerate, never-satisfiable "pullback")
//   mid   = L + 0.5 x (H - L)
//   fire iff current.close < H AND current.close > mid AND
//            current.close > current.open  (the continuation trigger:
//            the current bar itself must close green)
function testPullbackContinuation(bars: readonly OhlcCandle[]): boolean {
  const n = bars.length
  if (n < LOOKBACK_BARS + 1) return false
  const current = bars[n - 1]!
  const priorEight = bars.slice(n - 1 - LOOKBACK_BARS, n - 1) // indices n-9 .. n-2
  let hIdx = 0
  let h = -Infinity
  for (let i = 0; i < priorEight.length; i++) {
    if (priorEight[i]!.high > h) {
      h = priorEight[i]!.high
      hIdx = i
    }
  }
  // hIdx is relative to priorEight (which starts at absolute index n-9);
  // convert to an absolute index into `bars` for the recency check and
  // for slicing the post-H window.
  const hAbsoluteIdx = n - 1 - LOOKBACK_BARS + hIdx
  if (hAbsoluteIdx < n - 1 - RECENCY_BARS) return false // H not made within the last 4 closed bars

  const postH = bars.slice(hAbsoluteIdx + 1, n) // strictly after the H bar, through current inclusive
  if (postH.length === 0) return false
  const l = Math.min(...postH.map((b) => b.low))
  if (!(h > l)) return false // no real leg

  const mid = l + PULLBACK_MIDPOINT * (h - l)
  return current.close < h && current.close > mid && current.close > current.open
}

// Generic edge-trigger wrapper: true only when `test` is false on the
// window ending one bar earlier and true on the full window. Requires
// bars.length >= MIN_BARS (12) — one more than either detector's own
// 9-bar minimum, so the "prior" evaluation always has a full 9-bar
// window of its own, never a degenerate shorter one.
function edgeTriggered(bars: readonly OhlcCandle[], test: (b: readonly OhlcCandle[]) => boolean): boolean {
  const n = bars.length
  if (n < MIN_BARS) throw new InsufficientDataError('opportunity detection', MIN_BARS, n)
  const currentTrue = test(bars)
  const priorTrue = test(bars.slice(0, n - 1))
  return currentTrue && !priorTrue
}

// The one entry point strategy/registry.ts calls per FLAT asset, per
// cycle. `bars` must be the trailing MIN_BARS-or-more CLOSED 30m candles,
// oldest -> newest (IntradayMarketData.ohlc30m, already closed by
// construction — see types.ts). Returns at most one signal: if both
// detectors would fire on the same bar (edge cases only — their
// conditions are not mutually exclusive by construction), MOMENTUM_
// BREAKOUT takes precedence, since it is the simpler, more conservative
// condition of the two.
export function detectOpportunity(bars: readonly OhlcCandle[]): OpportunitySignal | null {
  const n = bars.length
  if (n < MIN_BARS) throw new InsufficientDataError('opportunity detection', MIN_BARS, n)
  const detectedAtBarTs = bars[n - 1]!.timestamp

  if (edgeTriggered(bars, testMomentumBreakout)) {
    return { kind: 'MOMENTUM_BREAKOUT', detectedAtBarTs }
  }
  if (edgeTriggered(bars, testPullbackContinuation)) {
    return { kind: 'PULLBACK_CONTINUATION', detectedAtBarTs }
  }
  return null
}
