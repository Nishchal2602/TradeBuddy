import type { Direction } from '../../../../../src/shared/positions/types.ts'

// Aggressive strategy — its OWN protection regime. Deliberately does NOT
// inherit strategy/rules.ts's stopLossPctFor/takeProfitPctFor (2.5% floor,
// 6x multiple) — that formula is derived for a weeks-long holding period
// (trading-strategy-v1.md §15's own cost arithmetic) and is incoherent at
// a 15-60 minute horizon. See context/specs/trading-strategy-aggressive-
// v3.md for the full derivation this file implements.

// atrPct is PERCENTAGE-AS-NUMBER (e.g. 0.40 means 0.40%) — the same
// convention indicators/calculate.ts's calculateATRPercent already
// returns, and the same one strategy/rules.ts's stopLossPctFor converts
// via /100. stopDistance/targetDistance below are FRACTIONS (0.008 means
// 0.8%), matching every other *Pct field in this codebase that is
// actually used as a multiplier (ModelDecisionProposal.stopLossPct etc.).
const STOP_ATR_MULTIPLE = 2.0
const STOP_FLOOR_PCT = 0.008 // 0.8% — cost-derived: 0.30% round trip = 0.375R at this stop
const TARGET_ATR_MULTIPLE = 4.0

export interface AggressiveProtection {
  stopLossPct: number
  takeProfitPct: number
  // Same number as takeProfitPct, re-exported under the name the
  // tradeability floor and the persisted cost-ratio diagnostic actually
  // use it as (migration plan §7: "derivable from the already-persisted
  // computed_take_profit_price and entry, so no new column" — this
  // function is where that derivation happens before persistence).
  atrTargetDistancePct: number
}

// ATR30's own /100 unit conversion happens here, once — callers pass the
// raw percentage-as-number ATR straight from calculateATRPercent(candles,
// 14) run against 30-minute true OHLC (never the 4-hourly candles
// Balanced uses — see strategy/aggressive/types.ts's own comment on why).
export function aggressiveProtectionFor(atr30Pct: number): AggressiveProtection {
  const atrFraction = atr30Pct / 100
  const stopLossPct = Math.max(STOP_ATR_MULTIPLE * atrFraction, STOP_FLOOR_PCT)
  const takeProfitPct = TARGET_ATR_MULTIPLE * atrFraction
  return { stopLossPct, takeProfitPct, atrTargetDistancePct: takeProfitPct }
}

// Tradeability floor (migration plan §3): no opportunity should be acted
// on at all — regardless of what a detector found — unless the ATR-
// derived target clears K times the round-trip cost. Below this, a 4xATR
// target is nearly consumed by fees+slippage before any real edge enters
// the picture. K=3 is pre-registered, not tuned.
//
// Both arguments must be the SAME unit (fraction, e.g. 0.016 for 1.6%) —
// estimatedRoundTripCostPct as computed by model/jev/management-
// question.ts's buildPositionSnapshot ((2*(feeBps+slippageBps))/10_000)
// is already a fraction despite its name, and atrTargetDistancePct above
// is returned as a fraction for exactly this reason: the two must be
// directly comparable without a caller having to remember a conversion.
export const TRADEABILITY_FLOOR_K = 3

export function clearsTradeabilityFloor(atrTargetDistancePct: number, estimatedRoundTripCostPct: number): boolean {
  return atrTargetDistancePct >= TRADEABILITY_FLOOR_K * estimatedRoundTripCostPct
}

// ============================================================================
// Aggressive V3.1 profit recycling (2026-09-23). Two R metrics, computed
// against the SAME immutable ruler (positions.initial_entry_price /
// initial_stop_loss_price / initial_risk_usd — captured once at original
// entry, never redefined by a later ADD/REDUCE) but answering two
// deliberately DIFFERENT questions. Conflating them into one "R" was a
// real error caught during plan review: after an ADD at a worse price,
// price can have travelled +1.25R from the original entry while the
// position is genuinely losing money. Never collapse these into one
// value or one column.
// ============================================================================

// MARKET-PATH metric — how far the current price has travelled from the
// ORIGINAL entry, in original-risk units. Quantity-independent (no term
// here references current quantity or a post-ADD weighted-average
// entry), which is exactly why it CANNOT be read as a profit statement:
// it doesn't know how large the position actually is. Context for Jev's
// trend reasoning only.
export function computePriceR(currentPrice: number, initialEntryPrice: number, initialStopLossPrice: number, direction: Direction): number {
  const riskPerUnit = Math.abs(initialEntryPrice - initialStopLossPrice)
  if (riskPerUnit <= 0) return 0
  const displacement = direction === 'long' ? currentPrice - initialEntryPrice : initialEntryPrice - currentPrice
  return displacement / riskPerUnit
}

// ECONOMIC metric — actual money made or lost by this position, in
// original-risk units. THE profit metric; drives every giveback decision
// below. unrealizedPnlUsd must be computed against the position's CURRENT
// entryPrice/quantity (the real weighted-average after any ADD) — never
// the initial ones, which would double-count the ADD's own price
// movement, and stays GROSS (mark-to-market, matching every other
// unrealized-P&L figure this codebase reports — the eventual exit's cost
// is hypothetical until it happens, and is separately weighed via costR
// below rather than pre-netted into a running number). partialRealizedPnlUsd
// (positions.partial_realized_pnl_usd, accumulated by every REDUCE) is
// what keeps this continuous across a partial exit — and is itself
// already NET of the fee that reduce actually paid (broker/accounting.ts's
// reducePosition), since that cost is sunk and known, not hypothetical.
// Without accumulating it at all, banking a deliberate profit would crater
// the unrealized-only figure and misreport as giveback; without netting
// the fee out of it, repeated REDUCEs would silently overstate protected
// profit by their cumulative fees.
export function computePositionPnlR(unrealizedPnlUsd: number, partialRealizedPnlUsd: number, initialRiskUsd: number): number {
  if (initialRiskUsd <= 0) return 0
  return (unrealizedPnlUsd + partialRealizedPnlUsd) / initialRiskUsd
}

// Cost floor, in R units — the denominator is still the immutable ruler,
// but the numerator is the round-trip cost of the CURRENT quantity (not
// the original), since a position enlarged by an ADD genuinely costs more
// to exit. currentRoundTripCostUsd is the existing deterministic broker
// fee+slippage cost for the current quantity, both sides — reused, not
// reimplemented.
export function computeCostR(currentRoundTripCostUsd: number, initialRiskUsd: number): number {
  if (initialRiskUsd <= 0) return 0
  return currentRoundTripCostUsd / initialRiskUsd
}

// --- Giveback ratchet (new, monitor-enforced — migration plan §5.1) -------
//
// Retires the old deterministicTighten schedule below it in this file's
// history. That mechanism's +1.5R rung computed a stop ABOVE entry for a
// long, which is IMPOSSIBLE to persist: positions_sl_tp_ordering_valid
// (a DB CHECK) and validateAbsoluteProtection both hard-require
// stopLoss < entry for a long — proven dead code, confirmed zero
// executions across the project's entire history. Its surviving +1.0R
// rung only ever parked the stop at entry*(1-minStopLossPct) ≈ -0.5%,
// which the plan's own diagnosis showed is not genuine breakeven. The
// ratchet below supersedes both: it protects the SAME threshold-crossing
// via a direct CLOSE the moment positionPnlR retraces past a floor keyed
// to the position's own best-ever P&L (sampledMfeR) — strictly more
// precise (a true cost-adjusted breakeven, not an approximation) and
// actually executable (a CLOSE has no ordering constraint against entry
// the way a stop-loss price does).
//
// Every threshold below is pre-registered judgment from Aggressive's own
// cost/volatility structure (0.30% round trip ≈ 0.375R at the 0.8% stop
// floor), not fitted to any observed trade outcome.

// Ascending MFE thresholds and their floors, in positionPnlR units.
// sampledMfeR is itself a monotone running max (position-monitor/
// giveback.ts), so feeding it through this non-decreasing step function
// is what makes the resulting floor monotone too — nextGivebackFloor
// below still ratchets explicitly against the previously stored value as
// defense in depth, not because this alone is provably insufficient.
export function rawGivebackFloor(sampledMfeR: number, costR: number): number | null {
  if (sampledMfeR >= 3.0) return 1.5
  if (sampledMfeR >= 2.0) return 1.0
  if (sampledMfeR >= 1.5) return 0.5
  if (sampledMfeR >= 1.0) return costR
  return null // below +1R, the trade hasn't proven itself — original stop remains the only protection
}

// The monotone ratchet step — combines the raw step-function value for
// the CURRENT sampledMfeR with whatever floor was already stored,
// guaranteeing the result never decreases even if sampledMfeR were ever
// (incorrectly) read as having declined, and never un-arms once armed.
export function nextGivebackFloor(sampledMfeR: number, costR: number, previousFloorR: number | null): number | null {
  const candidate = rawGivebackFloor(sampledMfeR, costR)
  if (candidate === null) return previousFloorR
  if (previousFloorR === null) return candidate
  return Math.max(candidate, previousFloorR)
}

// Exit condition — armed (a non-null floor exists) and current
// positionPnlR has retraced to or below it. Both sides of this comparison
// are positionPnlR-denominated; priceR never enters this decision.
export function shouldExecuteGivebackExit(positionPnlR: number, givebackFloorR: number | null): boolean {
  if (givebackFloorR === null) return false
  return positionPnlR <= givebackFloorR
}
