import type { Direction, PositionState } from '../positions/types.ts'
import type { ModelDecisionProposal, RiskStatus, SizeCapApplied } from '../decisions/types.ts'
import { computeStopLossTakeProfitPrices, validateAbsoluteProtection, validateStopLossTakeProfit, type SlTpBounds } from './sl-tp.ts'
import { applySizingCaps, deriveRiskBasedNotional, type SizingCaps, type PortfolioRiskInputs } from './sizing.ts'

export interface RecentStopLossClose {
  direction: Direction
  closedAt: string
}

// Phase 2 (2026-09-22) — the currently open position's OWN levels,
// distinct from RiskGateContext.entryPrice below (the CURRENT MARKET
// price — a name that predates Phase 2 and is kept for every existing
// call site/test rather than churned). ADD/REDUCE/MODIFY_PROTECTION all
// need to reason about the position they're acting on; none of them
// exist without one. Null exactly when currentState === 'FLAT'.
export interface OpenPositionSnapshot {
  quantity: number
  entryPrice: number
  stopLossPrice: number
  takeProfitPrice: number
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

  // trading-strategy-v1.md §17 — cross-asset portfolio risk, resolved by
  // the caller the same way effectiveSingleTradeCapPct etc. already are
  // (multiplier/pct x nav computed once in build-context.ts, not here).
  portfolioRiskCeilingUsd: number
  otherOpenPositionsRiskAtStopUsd: number
  maxTotalNotionalUsd: number
  otherSameDirectionNotionalUsd: number

  // §17.3 — blocks new OPENs only (never CLOSE, checked below in the same
  // place as every other open-only gate). peakNav is the portfolio's own
  // highest-ever NAV (max(nav_snapshots.nav) — stateless, no new table);
  // nav above is the CURRENT value already on this context.
  peakNav: number
  drawdownBreakerFloorPct: number

  // --- Phase 2 (2026-09-22) additions -----------------------------------
  // The open position ADD/REDUCE/MODIFY_PROTECTION act on. Null iff FLAT
  // — mirrors currentState exactly (both derived from the same read),
  // never independently inconsistent with it.
  openPosition: OpenPositionSnapshot | null
  // Fee/slippage headroom for the cash cap — closes a pre-existing hazard
  // (found during the Phase-2 audit, not introduced by it): the cash cap
  // previously passed raw `cash` as the affordable notional, but
  // netCashDelta on a BUY is -(grossValue + fee), which is strictly more
  // than the notional once slippage and fees are added. A cash-bound
  // OPEN or ADD could therefore drive cash_after negative and throw on
  // trades_cash_after_nonneg. ADD makes this more reachable (it spends
  // cash against an already-invested portfolio), so it's fixed here for
  // both OPEN and ADD rather than only for the new action.
  feeBps: number
  slippageBps: number
  // agent_settings.min_trade_notional_pct/_usd (Phase 2, both seeded
  // provisional) — applies to ADD and a PARTIAL reduce only, never to a
  // full CLOSE (see the REDUCE branch below for why).
  minTradeNotionalPct: number
  minTradeNotionalUsd: number
}

export interface RiskGateResult {
  riskStatus: RiskStatus
  riskReason: string | null
  // OPEN: this decision's approved size, as a fraction of NAV. ADD:
  // reuses the identical meaning — the approved ADD notional, as a
  // fraction of NAV. Null for REDUCE/MODIFY_PROTECTION/CLOSE/HOLD.
  approvedSizePct: number | null
  // OPEN: the computed absolute SL/TP for the new position.
  // MODIFY_PROTECTION: the FINAL absolute SL/TP this decision leaves in
  // place — the newly validated value if that leg changed, or the
  // position's existing unchanged value otherwise. Always both non-null
  // together for MODIFY_PROTECTION, so a caller never has to guess which
  // leg moved from a null vs a value.
  computedStopLossPrice: number | null
  computedTakeProfitPrice: number | null
  sizeCapApplied: SizeCapApplied | null

  // --- Phase 2 additions -------------------------------------------------
  // ADD: the approved absolute USD amount to add (post-cap) — the exact
  // figure broker/accounting.ts's addToPosition needs. REDUCE: the same
  // field carries the approved notional for provenance/logging, but
  // approvedReduceQuantity below is what the broker actually consumes
  // (REDUCE is defined as a fraction of QUANTITY, not of NAV — a
  // different unit than ADD, which is why it isn't just approvedSizePct
  // again).
  approvedAdjustNotionalUsd: number | null
  // REDUCE only: the approved quantity to reduce, already validated
  // against the current position's own quantity. Null for every other
  // action.
  approvedReduceQuantity: number | null
}

function minutesBetween(fromIso: string, toIso: string): number {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000
}

function notApplicable(): RiskGateResult {
  return {
    riskStatus: 'not_applicable', riskReason: null, approvedSizePct: null,
    computedStopLossPrice: null, computedTakeProfitPrice: null, sizeCapApplied: null,
    approvedAdjustNotionalUsd: null, approvedReduceQuantity: null,
  }
}

function rejected(reason: string): RiskGateResult {
  return {
    riskStatus: 'rejected', riskReason: reason, approvedSizePct: null,
    computedStopLossPrice: null, computedTakeProfitPrice: null, sizeCapApplied: null,
    approvedAdjustNotionalUsd: null, approvedReduceQuantity: null,
  }
}

// A cash-bound trade must leave room for fee + slippage on top of the
// notional itself, or cash_after can go negative (the pre-existing hazard
// documented on RiskGateContext.feeBps above). Derivation: for a BUY,
// grossValue = notionalUsd * (1 + slippageBps/1e4) (since quantity =
// notionalUsd/referencePrice and fillPrice = referencePrice*(1+slippage)),
// and netCashDelta = -(grossValue + grossValue*feeBps/1e4). Solving for
// the largest notionalUsd such that the total cost <= cash gives this.
function affordableNotionalUsd(cash: number, feeBps: number, slippageBps: number): number {
  const costFactor = (1 + slippageBps / 10_000) * (1 + feeBps / 10_000)
  return cash / costFactor
}

function evaluateOpen(
  proposal: Extract<ModelDecisionProposal, { action: 'OPEN_LONG' | 'OPEN_SHORT' }>,
  context: RiskGateContext,
  direction: Direction,
): RiskGateResult {
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

  // trading-strategy-v1.md §17.3 — blocks OPENs only; CLOSE is handled in
  // its own branch and never reaches here. A drawdown breaker, not a
  // consecutive-loss breaker (§2.4/§17.4: a streak breaker would fire on
  // ordinary variance at realistic hit rates — this measures NAV
  // magnitude instead).
  if (context.peakNav > 0 && context.nav < context.peakNav * context.drawdownBreakerFloorPct) {
    const drawdownPct = (1 - context.nav / context.peakNav) * 100
    return rejected(`drawdown breaker active: NAV is ${drawdownPct.toFixed(1)}% below its peak of ${context.peakNav}, floor is ${((1 - context.drawdownBreakerFloorPct) * 100).toFixed(1)}%`)
  }

  const { stopLossPrice, takeProfitPrice } = computeStopLossTakeProfitPrices(direction, context.entryPrice, proposal.stopLossPct, proposal.takeProfitPct)

  const riskBasedNotional = deriveRiskBasedNotional(context.nav, context.effectiveRiskBudgetPct, context.entryPrice, stopLossPrice)
  const caps: SizingCaps = { maxSingleTradePct: context.effectiveSingleTradeCapPct, maxAssetExposurePct: context.effectiveAssetExposureCapPct }
  const portfolioRisk: PortfolioRiskInputs = {
    stopLossPct: proposal.stopLossPct,
    portfolioRiskCeilingUsd: context.portfolioRiskCeilingUsd,
    otherOpenPositionsRiskAtStopUsd: context.otherOpenPositionsRiskAtStopUsd,
    maxTotalNotionalUsd: context.maxTotalNotionalUsd,
    otherSameDirectionNotionalUsd: context.otherSameDirectionNotionalUsd,
  }
  // Phase 2 (2026-09-22): affordableCashUsd now reserves fee+slippage
  // headroom instead of passing raw cash — see affordableNotionalUsd's
  // own comment for the pre-existing hazard this closes.
  const affordableCashUsd = affordableNotionalUsd(context.cash, context.feeBps, context.slippageBps)
  const sizing = applySizingCaps(riskBasedNotional, context.nav, caps, context.currentAssetExposureUsd, affordableCashUsd, portfolioRisk)

  // A cap (most often affordable cash) can legitimately drive the sizeable
  // notional to zero or below — that's not a small approved trade, it's no
  // trade at all. No minimum-viable-notional floor above zero is defined
  // for a fresh OPEN (unspecified, not silently invented — flagged in
  // progress-tracker.md; Phase 2's floor applies to ADD/REDUCE only, per
  // an explicit product decision not to touch OPEN's own semantics); this
  // only guards the unambiguous <= 0 case.
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
    approvedAdjustNotionalUsd: null,
    approvedReduceQuantity: null,
  }
}

// Phase 2 (2026-09-22) — Jev may choose a bounded adjustment magnitude;
// this function remains the sole authority over final size, exactly as
// it already is for a fresh OPEN. The risk-derived headroom is computed
// against the EXISTING position's own stop (not a freshly proposed one —
// ADD never changes the stop), at the CURRENT market price.
function evaluateAdd(proposal: Extract<ModelDecisionProposal, { action: 'ADD' }>, context: RiskGateContext): RiskGateResult {
  if (context.currentState === 'FLAT' || !context.openPosition) {
    return rejected('no open position to add to')
  }
  const position = context.openPosition
  const direction: Direction = context.currentState === 'LONG' ? 'long' : 'short'

  const riskBasedMaxAdd = deriveRiskBasedNotional(context.nav, context.effectiveRiskBudgetPct, context.entryPrice, position.stopLossPrice)
  const proposedNotional = riskBasedMaxAdd * proposal.addMagnitude

  const caps: SizingCaps = { maxSingleTradePct: context.effectiveSingleTradeCapPct, maxAssetExposurePct: context.effectiveAssetExposureCapPct }
  // Equivalent stop-distance fraction for the portfolio-risk cap formula
  // (expressed in pct-of-current-price terms) — derived from the
  // existing absolute stop against the CURRENT price, the same
  // reference-price convention this file already uses throughout.
  const stopDistancePct = Math.abs(context.entryPrice - position.stopLossPrice) / context.entryPrice
  const portfolioRisk: PortfolioRiskInputs = {
    stopLossPct: stopDistancePct,
    portfolioRiskCeilingUsd: context.portfolioRiskCeilingUsd,
    otherOpenPositionsRiskAtStopUsd: context.otherOpenPositionsRiskAtStopUsd,
    maxTotalNotionalUsd: context.maxTotalNotionalUsd,
    otherSameDirectionNotionalUsd: context.otherSameDirectionNotionalUsd,
  }
  const currentAssetExposureUsd = position.quantity * context.entryPrice
  const affordableCashUsd = affordableNotionalUsd(context.cash, context.feeBps, context.slippageBps)
  const sizing = applySizingCaps(proposedNotional, context.nav, caps, currentAssetExposureUsd, affordableCashUsd, portfolioRisk)

  if (sizing.notionalUsd <= 0) {
    return rejected(`no room to add: risk-derived size clamped to ${sizing.notionalUsd} by the ${sizing.capApplied ?? 'unknown'} cap`)
  }

  // Below the minimum viable trade notional (agent_settings.
  // min_trade_notional_pct/_usd, both provisional) — this is NOT a
  // rejection: nothing was wrong, the amount was just too small to be
  // worth a fill. `not_applicable` reuses the exact vocabulary a HOLD
  // already carries ("nothing to gate"), so the caller (agent-cycle/
  // index.ts) can normalize the persisted action to HOLD using this same
  // gate result, without a second gate call — see cycle/apply-
  // management.ts's own comment for the full reasoning.
  const minNotional = Math.max(context.minTradeNotionalPct * context.nav, context.minTradeNotionalUsd)
  if (sizing.notionalUsd < minNotional) {
    return { ...notApplicable(), riskReason: `ADD amount ${sizing.notionalUsd.toFixed(2)} below the minimum trade notional ${minNotional.toFixed(2)} — too small to be worth a fill, normalized to HOLD` }
  }

  // Re-validate the EXISTING SL/TP against the new weighted-average entry
  // this ADD would produce — using REFERENCE price throughout (the gate
  // never has access to a fill price). SL/TP themselves never move here;
  // only entry does, so ordering can break even though nothing about the
  // protection itself changed. Reject the ADD outright if so — SL/TP are
  // never silently moved to accommodate it.
  const addQuantity = sizing.notionalUsd / context.entryPrice
  const newQuantity = position.quantity + addQuantity
  const newEntryPrice = (position.quantity * position.entryPrice + addQuantity * context.entryPrice) / newQuantity
  const protectionCheck = validateAbsoluteProtection(direction, newEntryPrice, position.stopLossPrice, position.takeProfitPrice, context.slTpBounds)
  if (!protectionCheck.valid) {
    return rejected(`ADD rejected — existing protection becomes invalid under the new weighted entry: ${protectionCheck.reason}`)
  }

  return {
    riskStatus: sizing.capApplied === null ? 'approved' : 'clamped',
    riskReason: sizing.capApplied === null ? null : `risk-derived size clamped by the ${sizing.capApplied} cap`,
    approvedSizePct: sizing.sizePct,
    computedStopLossPrice: position.stopLossPrice,
    computedTakeProfitPrice: position.takeProfitPrice,
    sizeCapApplied: sizing.capApplied,
    approvedAdjustNotionalUsd: sizing.notionalUsd,
    approvedReduceQuantity: null,
  }
}

// Phase 2 (2026-09-22) — REDUCE is never capped upward (reducing risk is
// always fine, size-wise); only a floor (too small to bother) and a
// ceiling (never more than currently held) apply. A magnitude resolving
// to >= 100% is normalized to CLOSE upstream (cycle/apply-management.ts)
// and should never reach here — the Math.min clamp below is a defensive
// backstop, not the primary mechanism, matching this file's existing
// "verify derived values even when upstream constraints should already
// prevent it" discipline (see sl-tp.ts's own comment on the same point).
function evaluateReduce(proposal: Extract<ModelDecisionProposal, { action: 'REDUCE' }>, context: RiskGateContext): RiskGateResult {
  if (context.currentState === 'FLAT' || !context.openPosition) {
    return rejected('no open position to reduce')
  }
  const position = context.openPosition

  const reduceQuantity = Math.min(proposal.reduceMagnitude * position.quantity, position.quantity)
  if (reduceQuantity <= 0) {
    return rejected('REDUCE amount must be positive')
  }
  const reduceNotional = reduceQuantity * context.entryPrice

  const minNotional = context.minTradeNotionalPct * context.nav
  if (reduceNotional < minNotional) {
    return { ...notApplicable(), riskReason: `REDUCE amount ${reduceNotional.toFixed(2)} below the minimum trade notional ${minNotional.toFixed(2)} — too small to be worth a fill, normalized to HOLD` }
  }

  return {
    riskStatus: 'approved',
    riskReason: null,
    approvedSizePct: null,
    computedStopLossPrice: position.stopLossPrice,
    computedTakeProfitPrice: position.takeProfitPrice,
    sizeCapApplied: null,
    approvedAdjustNotionalUsd: reduceNotional,
    approvedReduceQuantity: reduceQuantity,
  }
}

// Phase 2 (2026-09-22) — Jev never proposes a price; cycle/apply-
// management.ts already resolved its intent (KEEP/TIGHTEN_TOWARD_ENTRY,
// KEEP/MOVE_CLOSER/MOVE_OUT) into these absolute prices. This function's
// only job is to VALIDATE them — never to compute them — exactly the
// same split evaluateOpen already applies to a fresh OPEN's SL/TP.
function evaluateModifyProtection(proposal: Extract<ModelDecisionProposal, { action: 'MODIFY_PROTECTION' }>, context: RiskGateContext): RiskGateResult {
  if (context.currentState === 'FLAT' || !context.openPosition) {
    return rejected('no open position to modify protection on')
  }
  const position = context.openPosition
  const direction: Direction = context.currentState === 'LONG' ? 'long' : 'short'

  const requestedStop = proposal.proposedStopLossPrice
  const requestedTarget = proposal.proposedTakeProfitPrice

  if (requestedStop !== null) {
    // The one rule this entire action exists to make unexpressible: a
    // stop may only ever tighten, never widen, regardless of what Jev
    // wants. Long tightens by moving UP (toward price); short tightens
    // by moving DOWN.
    const tightens = direction === 'long' ? requestedStop > position.stopLossPrice : requestedStop < position.stopLossPrice
    if (!tightens) {
      return rejected(`MODIFY_PROTECTION rejected — a stop-loss may only tighten, never widen (existing ${position.stopLossPrice}, requested ${requestedStop}); existing stop preserved`)
    }
    // A disguised CLOSE: a stop at or beyond the current market price
    // would execute immediately. MODIFY_PROTECTION must stay strictly
    // distinct from CLOSE.
    const wouldStopOutNow = direction === 'long' ? requestedStop >= context.entryPrice : requestedStop <= context.entryPrice
    if (wouldStopOutNow) {
      return rejected('MODIFY_PROTECTION rejected — requested stop-loss is at or beyond the current market price, which would execute immediately (use CLOSE instead)')
    }
  }

  if (requestedTarget !== null) {
    // Symmetric disguised-execution guard for a MOVE_CLOSER landing on or
    // past the current price.
    const wouldExecuteNow = direction === 'long' ? requestedTarget <= context.entryPrice : requestedTarget >= context.entryPrice
    if (wouldExecuteNow) {
      return rejected('MODIFY_PROTECTION rejected — requested take-profit is at or inside the current market price, which would execute immediately (use CLOSE instead)')
    }
  }

  const finalStop = requestedStop ?? position.stopLossPrice
  const finalTarget = requestedTarget ?? position.takeProfitPrice

  // Bounds/ordering/exhaustion re-validated against the position's own
  // fixed entry (MODIFY_PROTECTION never changes quantity or entry) —
  // the SAME predicate positions_sl_tp_ordering_valid enforces at the DB
  // level, reused here rather than re-derived.
  const protectionCheck = validateAbsoluteProtection(direction, position.entryPrice, finalStop, finalTarget, context.slTpBounds)
  if (!protectionCheck.valid) {
    return rejected(protectionCheck.reason ?? 'invalid stop-loss/take-profit')
  }

  return {
    riskStatus: 'approved',
    riskReason: null,
    approvedSizePct: null,
    computedStopLossPrice: finalStop,
    computedTakeProfitPrice: finalTarget,
    sizeCapApplied: null,
    approvedAdjustNotionalUsd: null,
    approvedReduceQuantity: null,
  }
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
    return {
      riskStatus: 'approved', riskReason: null, approvedSizePct: null,
      computedStopLossPrice: null, computedTakeProfitPrice: null, sizeCapApplied: null,
      approvedAdjustNotionalUsd: null, approvedReduceQuantity: null,
    }
  }

  // Phase 2 (2026-09-22): every remaining branch below is an explicit,
  // per-action dispatch — never a blanket `? 'long' : 'short'` derivation
  // that a future action could silently fall through into. This
  // structure is the actual fix for a real trap the pre-Phase-2 code had
  // (`gate.ts:111` used to read `const direction = proposal.action ===
  // 'OPEN_LONG' ? 'long' : 'short'` immediately after the HOLD/CLOSE
  // branches — any NEW action reaching that line would have been
  // silently mis-signed as a short open). The exhaustiveness check at the
  // bottom makes this a compile error, not just a documented convention,
  // the next time an action is added without its own branch here.

  if (proposal.action === 'OPEN_LONG' || proposal.action === 'OPEN_SHORT') {
    const direction: Direction = proposal.action === 'OPEN_LONG' ? 'long' : 'short'
    return evaluateOpen(proposal, context, direction)
  }

  if (proposal.action === 'ADD') {
    return evaluateAdd(proposal, context)
  }

  if (proposal.action === 'REDUCE') {
    return evaluateReduce(proposal, context)
  }

  if (proposal.action === 'MODIFY_PROTECTION') {
    return evaluateModifyProtection(proposal, context)
  }

  const exhaustive: never = proposal
  throw new Error(`evaluateRiskGate: unhandled action ${JSON.stringify(exhaustive)}`)
}
