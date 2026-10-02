import type { ArmId } from './detectors.ts'

// Strategy V4 (intraday_ls, 2026-10-01) — protection AT ORIGINATION only
// (plan §4.1). This is deliberately the ONLY piece of §4 built so far:
// registry.ts's exhaustive profile-dispatch switches (protectionForEntry,
// clearsEntryTradeabilityFloor) became compile errors the moment
// 'intraday_ls' was added to StrategyProfile, and a real formula is both
// more honest and barely more code than a stub. The REST of §4 — the new
// time_stop exit, funding accrual, position-monitor's six-exit precedence
// — is NOT built yet; nothing in this file is wired to any execution path
// in this pass (see index.ts's own module comment on why entries don't
// execute yet).

const STOP_ATR_MULTIPLE = 2.0
const STOP_FLOOR_PCT = 0.012 // 1.2% — cost-derived: 0.30% round trip = 0.25R at this stop, the cost gate's own boundary
const TARGET_RR_FADE = 1.5
const TARGET_RR_DEFAULT = 2.0
// Replaces Aggressive's K=3-against-the-TARGET floor (clearsTradeabilityFloor,
// aggressive/protection.ts) with a floor against the STOP instead — plan
// §4.1's own formula, a genuinely different ratio, not a renamed reuse.
export const COST_GATE_MAX_RATIO = 0.25

export interface IntradayLsProtection {
  stopLossPct: number
  takeProfitPct: number
}

// atr30Pct is percentage-as-number (e.g. 0.40 means 0.40%), the same
// calculateATRPercent convention every other protection formula in this
// codebase already uses. stopLossPct/takeProfitPct are fractions (0.012
// means 1.2%), matching every other *Pct field actually used as a
// multiplier (aggressive/protection.ts's own module comment makes the
// same unit-convention point).
export function computeIntradayLsProtection(armId: ArmId, atr30Pct: number): IntradayLsProtection {
  const atrFraction = atr30Pct / 100
  const stopLossPct = Math.max(STOP_ATR_MULTIPLE * atrFraction, STOP_FLOOR_PCT)
  const rewardRiskRatio = armId.startsWith('fade') ? TARGET_RR_FADE : TARGET_RR_DEFAULT
  const takeProfitPct = rewardRiskRatio * stopLossPct
  return { stopLossPct, takeProfitPct }
}

// Both arguments must be the same unit (fraction) — estimatedRoundTripCostPct
// is computed the same way everywhere else in this codebase ((2*(feeBps+
// slippageBps))/10_000), already a fraction despite its name.
export function passesIntradayLsCostGate(estimatedRoundTripCostPct: number, stopLossPct: number): boolean {
  return estimatedRoundTripCostPct / stopLossPct <= COST_GATE_MAX_RATIO
}
