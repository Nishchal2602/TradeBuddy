import type { SizeCapApplied } from '../decisions/types.ts'

export interface SizingCaps {
  maxSingleTradePct: number
  maxAssetExposurePct: number
}

export interface SizingResult {
  notionalUsd: number
  sizePct: number
  capApplied: SizeCapApplied | null
}

// Risk-derived notional before caps: the position size that keeps the
// dollar loss-at-stop equal to the risk budget, given this stop distance.
// Confidence is not an input here and never has been — it's a gate
// (evaluateRiskGate below), never a size multiplier
// (trading-domain-contract.md §4).
export function deriveRiskBasedNotional(
  nav: number,
  riskBudgetPct: number,
  entryPrice: number,
  stopLossPrice: number,
): number {
  const riskAmount = nav * riskBudgetPct
  const riskPerUnit = Math.abs(entryPrice - stopLossPrice)
  return (riskAmount / riskPerUnit) * entryPrice
}

// trading-strategy-v1.md §17 — the two genuinely NEW, cross-asset controls.
// Deliberately NOT a repair of currentAssetExposureUsd/maxAssetExposurePct
// above: those stay correctly inert (one net position per asset means an
// asset either has a brand-new open being sized, exposure 0 so far, or
// already has a position and can't be sized again — the gate's state
// check rejects OPEN_* before sizing ever runs). "Per-asset" and
// "per-trade" really are the same number in this system; what's actually
// missing is a CROSS-asset view (BTC's risk plus ETH's risk, combined),
// which needs data no single-asset RiskGateContext call has ever carried.
export interface PortfolioRiskInputs {
  // The stop distance for the candidate being sized (a fraction, e.g.
  // 0.025) — needed here to convert a remaining USD risk budget back into
  // an equivalent notional, the one thing this function didn't previously
  // need to know in notional-USD space.
  stopLossPct: number
  // portfolioRiskCeilingMultiplier x effectiveRiskBudgetPct x nav,
  // resolved once by the caller (same pattern as every other effective_*
  // value) — §17.1.
  portfolioRiskCeilingUsd: number
  // Sum of (notional x stopLossPct) across every OTHER currently open
  // position — deliberately excludes the candidate itself, which is what
  // makes "remaining room" meaningful.
  otherOpenPositionsRiskAtStopUsd: number
  // maxTotalNotionalPct x nav, resolved by the caller — §17.2.
  maxTotalNotionalUsd: number
  // Sum of notional across every OTHER open position in the SAME
  // direction as the candidate (long-only in V1, so "same direction"
  // is every open position today — kept as a real, direction-filtered
  // parameter rather than hardcoded so this doesn't need to change the
  // day V1.1 adds shorts back).
  otherSameDirectionNotionalUsd: number
}

// Applies the hard caps in the order the position-model plan's worked
// example uses, taking whichever is smallest. currentAssetExposureUsd is
// always 0 for a new open in V0/V1 — one net position per asset, and opens
// only happen from FLAT (src/shared/positions/types.ts), so there is
// never pre-existing exposure on the asset being opened. It's still a
// real parameter rather than a hardcoded 0: the maxAssetExposurePct cap
// is structurally inert for exactly this reason, but becomes load-bearing
// the moment pyramiding/multi-leg positions exist, and this function
// shouldn't need to change when that day comes.
export function applySizingCaps(
  riskBasedNotionalUsd: number,
  nav: number,
  caps: SizingCaps,
  currentAssetExposureUsd: number,
  affordableCashUsd: number,
  portfolioRisk: PortfolioRiskInputs,
): SizingResult {
  const candidates: Array<[number, SizeCapApplied | null]> = [
    [riskBasedNotionalUsd, null],
    [nav * caps.maxSingleTradePct, 'single_trade'],
    [nav * caps.maxAssetExposurePct - currentAssetExposureUsd, 'asset_exposure'],
    [affordableCashUsd, 'cash'],
    [
      (portfolioRisk.portfolioRiskCeilingUsd - portfolioRisk.otherOpenPositionsRiskAtStopUsd) / portfolioRisk.stopLossPct,
      'portfolio_risk',
    ],
    [portfolioRisk.maxTotalNotionalUsd - portfolioRisk.otherSameDirectionNotionalUsd, 'total_notional'],
  ]

  let [notionalUsd, capApplied] = candidates[0]!
  for (const [value, cap] of candidates.slice(1)) {
    if (value < notionalUsd) {
      notionalUsd = value
      capApplied = cap
    }
  }

  return { notionalUsd, sizePct: notionalUsd / nav, capApplied }
}
