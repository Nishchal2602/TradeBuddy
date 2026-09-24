import type { ModelDecisionProposal } from '../../../../src/shared/decisions/types.ts'
import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'
import type { Direction } from '../../../../src/shared/positions/types.ts'
import type { ManagementOutcome, StopIntent, TargetIntent } from '../model/jev/provider.ts'

// Phase 2 (2026-09-22) — the single place a Jev management decision turns
// into a ModelDecisionProposal, mirroring cycle/apply-veto.ts's role
// exactly: this module is what makes "Jev proposes intent, deterministic
// code computes and validates" true structurally. Only invoked when Pass
// 1's own deterministic candidate for this asset is HOLD (the regime is
// intact and the position stays open this cycle) — a regime-flip CLOSE
// from Pass 1 is authoritative and is never routed through here or
// through Jev at all; management is only ever asked about a position the
// deterministic system has already decided to keep open this cycle,
// exactly the same "Jev only evaluates what the deterministic strategy
// already proposed" shape the veto uses for FLAT candidates.
//
// Jev never proposes a price. Every field this function puts on an ADD/
// REDUCE proposal is a bounded, code-defined FRACTION (never a dollar
// figure) — the risk gate remains the sole authority that turns it into
// an absolute, capped size (src/shared/risk/gate.ts's evaluateAdd/
// evaluateReduce). For MODIFY_PROTECTION, this function is the
// "deterministic code computes the price" step: Jev's stop/target
// INTENT (KEEP/TIGHTEN_TOWARD_ENTRY, KEEP/MOVE_CLOSER/MOVE_OUT) becomes
// an absolute price here, which the gate then VALIDATES — never trusts —
// exactly the same split strategy/rules.ts already applies to a fresh
// OPEN_LONG's stopLossPct/takeProfitPct.

export interface ManagementPositionContext {
  direction: Direction
  entryPrice: number
  currentPrice: number
  stopLossPrice: number
  takeProfitPrice: number
  // ATR%, already computed by indicators/calculate.ts — same
  // percentage-as-number convention as strategy/rules.ts's own atrPct
  // (1.10 means 1.10%), used for the TP step exactly as
  // model/jev/management-question.ts's own comment documents.
  atrPct: number
  // agent_settings.min_stop_loss_pct — the same configured bound the gate
  // will re-validate against; used here only to compute what "tightest
  // legal stop near breakeven" concretely means, never to bypass that
  // validation.
  minStopLossPct: number
}

// "Breakeven" cannot be a literal SL === entry: positions_sl_tp_ordering_
// valid requires the STRICT inequality stopLossPrice < entryPrice for a
// long (and the reverse for a short), so a stop exactly at entry is
// invalid at the DB level. This computes the tightest LEGAL stop just
// inside entry instead — matching the migration plan's own §5 formula
// exactly.
function buildStopProposal(intent: StopIntent, position: ManagementPositionContext): number | null {
  if (intent === 'KEEP') return null
  return position.direction === 'long'
    ? position.entryPrice * (1 - position.minStopLossPct)
    : position.entryPrice * (1 + position.minStopLossPct)
}

// One ATR-in-price-terms step, toward or away from the current price —
// migration plan §6's exact formula. atrPct is percentage-as-number
// (1.10 means 1.10%), so the /100 conversion is real and deliberate, the
// same unit conversion strategy/rules.ts's stopLossPctFor already
// performs (and the same class of error a dedicated test guards there).
function buildTargetProposal(intent: TargetIntent, position: ManagementPositionContext): number | null {
  if (intent === 'KEEP') return null
  const atrPrice = (position.atrPct / 100) * position.currentPrice
  if (position.direction === 'long') {
    return intent === 'MOVE_CLOSER' ? position.takeProfitPrice - atrPrice : position.takeProfitPrice + atrPrice
  }
  return intent === 'MOVE_CLOSER' ? position.takeProfitPrice + atrPrice : position.takeProfitPrice - atrPrice
}

export function applyManagementOutcome(
  candidate: ModelDecisionProposal,
  asset: AssetSymbol,
  outcome: ManagementOutcome,
  position: ManagementPositionContext,
): ModelDecisionProposal {
  // Base fields shared by every variant, carried from the Pass-1 HOLD
  // candidate this function only ever receives — confidence is
  // overwritten with Jev's own actionConfidence (persisted for
  // observation; the gate does not gate on it — see the migration plan's
  // explicit reversal on this point) so it is never silently lost.
  const base = {
    asset: candidate.asset,
    confidence: outcome.actionConfidence,
    horizonHours: candidate.horizonHours,
    reasons: candidate.reasons,
    invalidation: candidate.invalidation,
  }

  switch (outcome.action) {
    case 'HOLD':
      return candidate

    case 'CLOSE':
      return { ...base, action: 'CLOSE' }

    case 'ADD':
      return { ...base, action: 'ADD', addMagnitude: outcome.addMagnitude }

    case 'REDUCE':
      return { ...base, action: 'REDUCE', reduceMagnitude: outcome.reduceMagnitude }

    case 'MODIFY_PROTECTION': {
      const proposedStopLossPrice = buildStopProposal(outcome.stopIntent, position)
      const proposedTakeProfitPrice = buildTargetProposal(outcome.targetIntent, position)
      // Both legs resolved to "no change" — normalize to HOLD rather than
      // building a no-op MODIFY_PROTECTION (migration plan §3's
      // normalization rule: a MODIFY_PROTECTION whose SL and TP both
      // resolve to "unchanged" is rewritten to HOLD).
      if (proposedStopLossPrice === null && proposedTakeProfitPrice === null) return candidate
      return { ...base, action: 'MODIFY_PROTECTION', proposedStopLossPrice, proposedTakeProfitPrice }
    }
  }
}
