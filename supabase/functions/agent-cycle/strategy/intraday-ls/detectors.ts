import type { NormalizedMarketData, OhlcCandle } from '../../../../../src/shared/market-data/types.ts'
import { InsufficientDataError, calculateATRPercent, calculateDistanceFromSevenDayRange, calculateRSI } from '../../indicators/calculate.ts'
import { MIN_BARS, edgeTriggered, testMomentumBreakout, testPullbackContinuation } from '../aggressive/detectors.ts'
import { invertBars } from './mirror.ts'
import type { Bias } from './bias.ts'

// Strategy V4 (intraday_ls, 2026-10-01) — the six detector arms (plan
// §3.2). Deterministic opportunity detection only, the same non-negotiable
// split as Aggressive: these functions detect that an objective condition
// fired; Jev then judges whether it's worth acting on (entry_quality, in
// advisory mode — see model/jev/entry-question.ts). Jev can never invent
// an entry where no arm fired.

export type ArmId = 'breakout_long' | 'breakout_short' | 'pullback_long' | 'pullback_short' | 'fade_long' | 'fade_short'
export type Direction = 'long' | 'short'

// CFG-1 Stage 0 (2026-10-06) — the six arm ids look like six independent
// strategies, but statistically they are one of three setup families
// crossed with direction (itself already a first-class field on
// IntradayLsOpportunity, never re-derived from the id string). Persisting
// arm_family as its OWN column (agent_decisions) is what makes "does
// pullback work independent of direction?" answerable with a GROUP BY
// instead of a LIKE '%pullback%' string match against six isolated
// buckets.
export type ArmFamily = 'breakout' | 'pullback' | 'fade'

export function armFamilyOf(armId: ArmId): ArmFamily {
  if (armId.startsWith('breakout')) return 'breakout'
  if (armId.startsWith('pullback')) return 'pullback'
  return 'fade'
}

export interface IntradayLsOpportunity {
  armId: ArmId
  direction: Direction
  // Close timestamp of the bar/candle that triggered detection — for
  // breakout/pullback, a 30-minute bar; for fade, an hourly close (see
  // detectFadeOpportunity's own comment). Compared against this asset's
  // lastConsumedOpportunityBarTs by the caller (lifecycle.ts) before a
  // candidate is ever built — this field alone is what makes "fire once"
  // true across a 60-minute cadence that re-scans a trailing window every
  // cycle, not a single most-recent bar.
  detectedAtBarTs: string
}

// --- Window-scanned detection (plan §3.3) ----------------------------------
//
// At 60-minute cadence with 30-minute bars, inspecting only the single
// most recent bar misses every second bar close — and these are
// edge-triggered, so a missed edge is gone, not delayed. Instead: scan
// backwards over the last WINDOW_SCAN_BARS closed bars and take the MOST
// RECENT edge. edgeTriggered (aggressive/detectors.ts, reused unchanged)
// is already pure over "the last element is current, everything else is
// history," so evaluating "was there an edge as of position n-1-k" is
// just edgeTriggered(bars.slice(0, n-k), test) for k = 0..WINDOW_SCAN_BARS-1,
// checked from k=0 (current) backward so the first hit found IS the most
// recent one.
export const WINDOW_SCAN_BARS = 4
// The minimum bars a window-scanned detector needs: MIN_BARS for the
// OLDEST scan position (k = WINDOW_SCAN_BARS-1) to itself have a full,
// non-degenerate edgeTriggered window.
export const MIN_BARS_FOR_WINDOW_SCAN = MIN_BARS + WINDOW_SCAN_BARS - 1

export interface EdgeScanResult {
  barIndex: number
  barTs: string
}

export function scanForEdge(bars: readonly OhlcCandle[], test: (b: readonly OhlcCandle[]) => boolean): EdgeScanResult | null {
  const n = bars.length
  // Mirrors aggressive/detectors.ts's own edgeTriggered: throw when even
  // the k=0 (current) position can't be evaluated at all — this should
  // be unreachable once V4's own data-sufficiency gate (registry.ts,
  // requiring >= MIN_BARS_FOR_WINDOW_SCAN) is wired, same as that file's
  // own "fail closed on malformed/truncated upstream data" guard.
  if (n < MIN_BARS) throw new InsufficientDataError('intraday_ls edge scan', MIN_BARS, n)
  for (let k = 0; k < WINDOW_SCAN_BARS; k++) {
    const windowLen = n - k
    // Not enough history for this FURTHER-BACK scan position only — an
    // expected, normal situation with exactly MIN_BARS..MIN_BARS_FOR_
    // WINDOW_SCAN-1 bars, not an error: degrade to whatever positions
    // the data actually supports instead of throwing.
    if (windowLen < MIN_BARS) break
    if (edgeTriggered(bars.slice(0, windowLen), test)) {
      return { barIndex: windowLen - 1, barTs: bars[windowLen - 1]!.timestamp }
    }
  }
  return null
}

// --- Breakout / pullback (mirrored onto inverted bars for the short arms) -
//
// Confirmation (breakout only, plan §3.2): volumeTrendRatio >= 1.2 AND the
// REAL (never inverted) ret60mPct's sign matches the trade's own
// direction — these come from computeIntradayFeatures, already computed
// on real 5-minute prices regardless of which direction is being
// detected, so they are never inverted themselves; only the 30m bars fed
// to testMomentumBreakout are.
const BREAKOUT_MIN_VOLUME_TREND_RATIO = 1.2

export interface BreakoutConfirmation {
  ret60mPct: number
  volumeTrendRatio: number
}

export function detectBreakout(direction: Direction, bars30m: readonly OhlcCandle[], confirmation: BreakoutConfirmation): IntradayLsOpportunity | null {
  const workingBars = direction === 'long' ? bars30m : invertBars(bars30m)
  const scan = scanForEdge(workingBars, testMomentumBreakout)
  if (!scan) return null

  const directionConfirmed = direction === 'long' ? confirmation.ret60mPct > 0 : confirmation.ret60mPct < 0
  if (confirmation.volumeTrendRatio < BREAKOUT_MIN_VOLUME_TREND_RATIO || !directionConfirmed) return null

  return { armId: direction === 'long' ? 'breakout_long' : 'breakout_short', direction, detectedAtBarTs: scan.barTs }
}

// Pullback's own confirmation is already embedded in testPullbackContinuation
// (the current bar must close green; mirrored onto inverted bars, this
// becomes "must close red" — exactly right for a downtrend pullback
// resuming down). No separate confirmation input needed here.
export function detectPullback(direction: Direction, bars30m: readonly OhlcCandle[]): IntradayLsOpportunity | null {
  const workingBars = direction === 'long' ? bars30m : invertBars(bars30m)
  const scan = scanForEdge(workingBars, testPullbackContinuation)
  if (!scan) return null
  return { armId: direction === 'long' ? 'pullback_long' : 'pullback_short', direction, detectedAtBarTs: scan.barTs }
}

// --- Fade (NEUTRAL bias only) ------------------------------------------
//
// Never mirrored — RSI and ATR%/distance-from-range are RATIOS, which
// negative prices break (mirror.ts's own module comment). Written
// directly against real prices instead, on the SAME hourly-closes (RSI)
// and 4-hourly-candles (ATR%, 7-day range) NormalizedMarketData already
// carries — no new data, no new request.
//
// Edge-triggered via a simple current-vs-one-prior comparison (dropping
// the latest point from each series and recomputing), NOT the WINDOW_SCAN_BARS
// scan breakout/pullback need: that scan exists specifically because
// 30-minute bars update twice as fast as the 60-minute decision cadence.
// Fade's own inputs (hourly RSI, 4-hourly ATR/range) update AT MOST once
// per cycle — a 1:1 match with cadence, not the 2:1 mismatch the 30m arms
// have — so there is no "missed bar" gap for a window scan to close here.
const FADE_RSI_OVERSOLD = 30
const FADE_RSI_OVERBOUGHT = 70
const FADE_RANGE_ATR_MULTIPLE = 1.0
// RSI(14) needs 15 closes; the "prior" evaluation drops one more.
const MIN_CLOSES_FOR_FADE = 16
// ATR(14)/7-day-range need 15 candles; same one-more for "prior".
const MIN_CANDLES_FOR_FADE = 16

function fadeLongCondition(rsi14: number, atrPct: number, distanceFromSevenDayLowPct: number): boolean {
  return rsi14 <= FADE_RSI_OVERSOLD && distanceFromSevenDayLowPct <= FADE_RANGE_ATR_MULTIPLE * atrPct
}

function fadeShortCondition(rsi14: number, atrPct: number, distanceFromSevenDayHighPct: number): boolean {
  return rsi14 >= FADE_RSI_OVERBOUGHT && distanceFromSevenDayHighPct >= -FADE_RANGE_ATR_MULTIPLE * atrPct
}

export function detectFadeOpportunity(bias: Bias, marketData: NormalizedMarketData): IntradayLsOpportunity | null {
  if (bias !== 'NEUTRAL') return null // fades are NEUTRAL-only (plan §3.1's bias table)

  const closes = marketData.closeSeries.map((p) => p.close)
  if (closes.length < MIN_CLOSES_FOR_FADE || marketData.candles.length < MIN_CANDLES_FOR_FADE) return null

  const priorCloses = closes.slice(0, -1)
  const priorCandles = marketData.candles.slice(0, -1)
  const priorPrice = priorCandles[priorCandles.length - 1]!.close

  const currentRsi = calculateRSI(closes, 14)
  const priorRsi = calculateRSI(priorCloses, 14)
  const currentAtrPct = calculateATRPercent(marketData.candles, 14)
  const priorAtrPct = calculateATRPercent(priorCandles, 14)
  const current = calculateDistanceFromSevenDayRange(marketData.candles, marketData.price)
  const prior = calculateDistanceFromSevenDayRange(priorCandles, priorPrice)

  const detectedAtBarTs = marketData.closeSeries[marketData.closeSeries.length - 1]!.timestamp

  const longNow = fadeLongCondition(currentRsi, currentAtrPct, current.distanceFromLowPct)
  const longPrior = fadeLongCondition(priorRsi, priorAtrPct, prior.distanceFromLowPct)
  if (longNow && !longPrior) {
    return { armId: 'fade_long', direction: 'long', detectedAtBarTs }
  }

  const shortNow = fadeShortCondition(currentRsi, currentAtrPct, current.distanceFromHighPct)
  const shortPrior = fadeShortCondition(priorRsi, priorAtrPct, prior.distanceFromHighPct)
  if (shortNow && !shortPrior) {
    return { armId: 'fade_short', direction: 'short', detectedAtBarTs }
  }

  return null
}

// --- Combined entry point -----------------------------------------------
//
// One candidate per asset per cycle (plan §3.2). Priority breakout ->
// pullback -> fade is structurally guaranteed rather than computed: LONG
// bias only ever attempts breakout_long/pullback_long, SHORT only
// breakout_short/pullback_short, NEUTRAL only the two fades (mutually
// exclusive by construction — RSI cannot be both <=30 and >=70) — there
// is never a cross-bias-regime tie to break.
export function detectIntradayLsOpportunity(
  bias: Bias,
  bars30m: readonly OhlcCandle[],
  breakoutConfirmation: BreakoutConfirmation,
  marketData: NormalizedMarketData,
): IntradayLsOpportunity | null {
  if (bias === 'LONG' || bias === 'SHORT') {
    const direction: Direction = bias === 'LONG' ? 'long' : 'short'
    const breakout = detectBreakout(direction, bars30m, breakoutConfirmation)
    if (breakout) return breakout
    return detectPullback(direction, bars30m)
  }
  return detectFadeOpportunity(bias, marketData)
}

// --- Signal-validity drift check (plan §3.2/§4.2) --------------------------
//
// A flip (closing a long, opening the opposite short) spans two decision
// cycles — the signal that justified it must still be fresh when the
// second cycle acts on it. "Fresh" means both: found within the
// WINDOW_SCAN_BARS scan above (already true by construction, since this
// is only ever called with an opportunity scanForEdge actually returned)
// AND price hasn't drifted more than half a stop distance beyond the
// trigger bar's own close. stopDistancePct is the fraction s from
// protection.ts (e.g. 0.012 for 1.2%), not a percentage-as-number.
export function isOpportunityStillValid(triggerBarClose: number, currentPrice: number, stopDistancePct: number): boolean {
  const drift = Math.abs(currentPrice - triggerBarClose) / triggerBarClose
  return drift <= 0.5 * stopDistancePct
}
