import type { Direction, PositionState } from '../positions/types.ts'
import type { ModelDecisionProposal, RiskStatus, SizeCapApplied } from '../decisions/types.ts'
import { computeStopLossTakeProfitPrices, validateStopLossTakeProfit, type SlTpBounds } from './sl-tp.ts'
import { applySizingCaps, deriveRiskBasedNotional, type SizingCaps } from './sizing.ts'

export interface RecentStopLossClose {
  direction: Direction
  closedAt: string
}

// Everything the gate needs, pre-assembled by the caller (eventually Step
// 7's agent-cycle). This function does no I/O — it's pure, matching
// code-standards.md "prefer pure functions for ... risk rules".
export interface RiskGateContext {
  currentState: PositionState
  // Current market reference price for this asset — not the eventual fill
  // price (trades.reference_price vs fill_price are already distinct;
  // the broker, Step 4, applies slippage on top of this).
  entryPrice: number
  nav: number
  cash: number

  effectiveMinConfidence: number
  effectiveRiskBudgetPct: number
  effectiveSingleTradeCapPct: number
  effectiveAssetExposureCapPct: number
  slTpBounds: SlTpBounds

  // Always 0 for a new open in V0 (see sizing.ts) — kept as a real
  // parameter rather than hardcoded so this function doesn't need to
  // change when pyramiding eventually makes it non-zero.
  currentAssetExposureUsd: number

  stopOutReentryBlockMinutes: number
  // The most recent stop-loss-triggered close for this asset, in EITHER
  // direction, if any. The gate only blocks re-entry when the direction
  // matches — trading-domain-contract.md §7: the opposite direction is a
  // different thesis, not the failed one.
  recentStopLossClose: RecentStopLossClose | null
  nowIso: string
}

export interface RiskGateResult {
  riskStatus: RiskStatus
  riskReason: string | null
  approvedSizePct: number | null
  computedStopLossPrice: number | null
  computedTakeProfitPrice: number | null
  sizeCapApplied: SizeCapApplied | null
}

function minutesBetween(fromIso: string, toIso: string): number {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000
}

function notApplicable(): RiskGateResult {
  return { riskStatus: 'not_applicable', riskReason: null, approvedSizePct: null, computedStopLossPrice: null, computedTakeProfitPrice: null, sizeCapApplied: null }
}

function rejected(reason: string): RiskGateResult {
  return { riskStatus: 'rejected', riskReason: reason, approvedSizePct: null, computedStopLossPrice: null, computedTakeProfitPrice: null, sizeCapApplied: null }
}

// Evaluation order matches trading-domain-contract.md / architecture.md §
// Risk Gate exactly — first failure wins. See each branch's comment for
// why it's placed where it is.
export function evaluateRiskGate(proposal: ModelDecisionProposal, context: RiskGateContext): RiskGateResult {
  if (proposal.action === 'HOLD') {
    // State-dependent invalidation requirement (trading-domain-contract.md
    // §1 / progress-tracker.md Open Questions, Step 6): a HOLD while FLAT
    // has no open thesis to invalidate, so empty invalidation is fine. A
    // HOLD on an open LONG/SHORT is implicitly reaffirming an existing
    // thesis — the prompt asks the model to reaffirm or explicitly revise
    // its invalidation conditions every such cycle, and until now nothing
    // deterministically checked that it actually did. This does not (and
    // cannot) verify the reaffirmed text is honest — only that the
    // structurally-checkable part (a real, non-empty list) is present.
    if (context.currentState !== 'FLAT' && proposal.invalidation.length === 0) {
      return rejected('HOLD on an open position must reaffirm or revise invalidation conditions')
    }
    return notApplicable()
  }

  if (proposal.action === 'CLOSE') {
    if (context.currentState === 'FLAT') {
      return rejected('no open position to close')
    }
    // CLOSE is never gated by confidence, the stop-out re-entry block, or
    // any exposure cap, under any condition — exits must always be
    // actionable (trading-domain-contract.md §7). No sizing decision
    // either: a close always exits the full position.
    return { riskStatus: 'approved', riskReason: null, approvedSizePct: null, computedStopLossPrice: null, computedTakeProfitPrice: null, sizeCapApplied: null }
  }

  // OPEN_LONG / OPEN_SHORT from here.
  const direction: Direction = proposal.action === 'OPEN_LONG' ? 'long' : 'short'

  if (context.currentState !== 'FLAT') {
    return rejected('position already open; CLOSE first')
  }

  if (proposal.confidence < context.effectiveMinConfidence) {
    return rejected(`confidence ${proposal.confidence} below effective minimum ${context.effectiveMinConfidence}`)
  }

  const slTpCheck = validateStopLossTakeProfit(direction, context.entryPrice, proposal.stopLossPct, proposal.takeProfitPct, context.slTpBounds)
  if (!slTpCheck.valid) {
    return rejected(slTpCheck.reason ?? 'invalid stop-loss/take-profit')
  }

  const stopOut = context.recentStopLossClose
  if (stopOut && stopOut.direction === direction && minutesBetween(stopOut.closedAt, context.nowIso) < context.stopOutReentryBlockMinutes) {
    return rejected(`stop-out re-entry block active for ${direction} ${proposal.asset} — ${context.stopOutReentryBlockMinutes - minutesBetween(stopOut.closedAt, context.nowIso)} minutes remaining`)
  }

  const { stopLossPrice, takeProfitPrice } = computeStopLossTakeProfitPrices(direction, context.entryPrice, proposal.stopLossPct, proposal.takeProfitPct)

  const riskBasedNotional = deriveRiskBasedNotional(context.nav, context.effectiveRiskBudgetPct, context.entryPrice, stopLossPrice)
  const caps: SizingCaps = { maxSingleTradePct: context.effectiveSingleTradeCapPct, maxAssetExposurePct: context.effectiveAssetExposureCapPct }
  const sizing = applySizingCaps(riskBasedNotional, context.nav, caps, context.currentAssetExposureUsd, context.cash)

  // A cap (most often affordable cash) can legitimately drive the sizeable
  // notional to zero or below — that's not a small approved trade, it's no
  // trade at all. No minimum-viable-notional floor above zero is defined
  // yet (unspecified, not silently invented — flagged in
  // progress-tracker.md); this only guards the unambiguous <= 0 case.
  if (sizing.notionalUsd <= 0) {
    return rejected(`no room to open: risk-derived size clamped to ${sizing.notionalUsd} by the ${sizing.capApplied ?? 'unknown'} cap`)
  }

  return {
    riskStatus: sizing.capApplied === null ? 'approved' : 'clamped',
    riskReason: sizing.capApplied === null ? null : `risk-derived size clamped by the ${sizing.capApplied} cap`,
    approvedSizePct: sizing.sizePct,
    computedStopLossPrice: stopLossPrice,
    computedTakeProfitPrice: takeProfitPrice,
    sizeCapApplied: sizing.capApplied,
  }
}
