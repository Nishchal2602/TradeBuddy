import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'
import type { Position } from '../../../../src/shared/positions/types.ts'
import type { ModelDecisionProposal } from '../../../../src/shared/decisions/types.ts'
import type { VetoCandidateInput } from '../model/payload.ts'
import type { AggressiveManagementContext, ManagementCandidateInput } from '../model/jev/management-question.ts'

// Phase 2.1 (2026-09-23) — extracted out of index.ts's Pass 1/veto-block
// specifically so the invariant this fix is about ("entry eligibility and
// position management are separate decisions") is a directly testable
// property of two pure functions, not an inline boolean expression only
// observable by reading index.ts or invoking a live cycle. Mirrors why
// apply-veto.ts and apply-management.ts were extracted in Phase 1/2.
//
// This module owns exactly two decisions, kept deliberately separate:
//   1. collectModelCandidates — WHAT, if anything, is there to ask about.
//   2. shouldCallModel        — WHETHER to actually spend a model call.
// Testing collection alone (e.g. "managementCandidates is empty for a
// FLAT asset") proves nothing about whether the caller then invokes the
// model anyway, or how a news-provider failure interacts with an
// otherwise-empty candidate set — that is shouldCallModel's own,
// separately-tested job.

// A structural subset of index.ts's own PassOneResult — only the fields
// candidate collection actually reads. index.ts maps its richer
// PassOneResult into this shape at the call site; nothing here needs to
// know about market data, regime, or recentStopLossClose.
export interface CandidateSource {
  asset: AssetSymbol
  candidate: ModelDecisionProposal
  openPosition: Position | null
  news: VetoCandidateInput['news']
  currentPrice: number
  atrPct: number
  // Aggressive V3.1 profit recycling (2026-09-23) — undefined for
  // Balanced, or whenever the caller has no intraday data for this asset
  // this cycle. Forwarded verbatim into ManagementCandidateInput.
  // aggressive; this module has no opinion on strategy profiles itself,
  // matching its existing "just pass through whatever the caller
  // computed" pattern for atrPct/currentPrice.
  aggressive?: AggressiveManagementContext
}

export interface CandidateFlags {
  // Entry-veto layer's own switch (pre-existing column, unchanged
  // meaning) — gates ONLY vetoCandidates collection now. Phase 2
  // deployed with this flag silently also gating management (the real
  // defect Phase 2.1 fixes): the two layers are independent product
  // decisions and must have independent switches.
  newsVetoEnabled: boolean
  // New column (this migration) — gates ONLY managementCandidates
  // collection. Independent of newsVetoEnabled by construction: this
  // interface has no way to accidentally couple them again, since each
  // flag is read by exactly one branch below.
  managementEnabled: boolean
  feeBps: number
  slippageBps: number
  // Shared by both profiles — management-question.ts's
  // isProtectionActionable needs this to decide whether a legal stop
  // tighten exists at all before offering MODIFY_PROTECTION.
  minStopLossPct: number
}

export interface CollectedCandidates {
  vetoCandidates: VetoCandidateInput[]
  managementCandidates: ManagementCandidateInput[]
}

// Per-asset routing is unchanged from Phase 2, just now a pure, directly
// testable function rather than an inline loop in index.ts:
//   FLAT + OPEN_LONG candidate  -> a veto candidate (entry eligibility)
//   OPEN position + HOLD candidate -> a management candidate (the regime
//     is intact; a regime-flip CLOSE is authoritative and deliberately
//     never reaches here — trading-strategy-v1.md's thesis-invalidation
//     rule is not overridable by Jev, in either direction)
//   Anything else (FLAT + no candidate, OPEN + CLOSE, no position at all)
//     -> neither list, by construction.
// A single candidate.action can only route to at most one of the two
// branches (OPEN_LONG vs HOLD are mutually exclusive on ModelDecisionProposal),
// so no asset is ever double-counted across both lists.
export function collectModelCandidates(
  sources: readonly CandidateSource[],
  flags: CandidateFlags,
  nowIso: string,
): CollectedCandidates {
  const vetoCandidates: VetoCandidateInput[] = []
  const managementCandidates: ManagementCandidateInput[] = []

  for (const source of sources) {
    if (flags.newsVetoEnabled && source.candidate.action === 'OPEN_LONG') {
      vetoCandidates.push({ asset: source.asset, news: source.news })
    } else if (flags.managementEnabled && source.openPosition && source.candidate.action === 'HOLD') {
      const position = source.openPosition
      managementCandidates.push({
        asset: source.asset,
        direction: position.direction,
        entryPrice: position.entryPrice,
        currentPrice: source.currentPrice,
        quantity: position.quantity,
        stopLossPrice: position.stopLossPrice,
        takeProfitPrice: position.takeProfitPrice,
        heldHours: (new Date(nowIso).getTime() - new Date(position.openedAt).getTime()) / 3_600_000,
        feeBps: flags.feeBps,
        slippageBps: flags.slippageBps,
        atrPct: source.atrPct,
        news: source.news,
        minStopLossPct: flags.minStopLossPct,
        aggressive: source.aggressive,
      })
    }
  }

  return { vetoCandidates, managementCandidates }
}

// The complete "should we spend a model call this cycle?" decision —
// deliberately a separate function from collection above, so a test can
// prove the FULL chain (candidates exist -> call happens) rather than
// only the first half. modelCallFailedReason (set by a news-provider
// failure while either layer is enabled — index.ts's own
// anyModelLayerEnabled seeding) fails EVERY candidate of both kinds
// closed for the cycle, by design: see the "News-provider failure" named
// invariant in CLAUDE.md / architecture.md for the product consequence
// of that choice (a quiet day with no management action can mean the
// model was never called, not that it chose HOLD — agent_decisions.
// model_version distinguishes 'call-failed' from a genuine 'jev-*' call
// specifically so this is never ambiguous after the fact).
export function shouldCallModel(
  vetoCandidates: readonly VetoCandidateInput[],
  managementCandidates: readonly ManagementCandidateInput[],
  modelCallFailedReason: string | null,
): boolean {
  if (modelCallFailedReason !== null) return false
  return vetoCandidates.length > 0 || managementCandidates.length > 0
}
