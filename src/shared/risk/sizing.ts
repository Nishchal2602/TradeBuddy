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

// Applies the hard caps in the order the position-model plan's worked
// example uses, taking whichever is smallest. currentAssetExposureUsd is
// always 0 for a new open in V0 — one net position per asset, and opens
// only happen from FLAT (src/shared/positions/types.ts), so there is
// never pre-existing exposure on the asset being opened. It's still a
// real parameter rather than a hardcoded 0: the maxAssetExposurePct cap
// is structurally inert in V0 for exactly this reason, but becomes load-
// bearing the moment pyramiding/multi-leg positions exist, and this
// function shouldn't need to change when that day comes.
export function applySizingCaps(
  riskBasedNotionalUsd: number,
  nav: number,
  caps: SizingCaps,
  currentAssetExposureUsd: number,
  affordableCashUsd: number,
): SizingResult {
  const candidates: Array<[number, SizeCapApplied | null]> = [
    [riskBasedNotionalUsd, null],
    [nav * caps.maxSingleTradePct, 'single_trade'],
    [nav * caps.maxAssetExposurePct - currentAssetExposureUsd, 'asset_exposure'],
    [affordableCashUsd, 'cash'],
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
