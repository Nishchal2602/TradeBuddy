import type { ModelDecisionProposal } from '../../../../src/shared/decisions/types.ts'
import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'
import { vetoedHoldProposal } from '../strategy/rules.ts'
import { JEV_VETO_THRESHOLD } from '../model/jev/provider.ts'
import type { VetoOutcome } from '../model/jev/provider.ts'

// Extracted out of index.ts's Pass 2 loop specifically so the single most
// important regression test in the Gemini -> Jev migration (the user's
// explicit revision #4) can be asserted directly against this function
// rather than only observed live: when outcome.veto is false (ALLOW),
// `candidate` is returned BY REFERENCE, completely untouched — Jev can
// only ever cause this function to swap in a deterministic HOLD, never
// alter, augment, or reshape the candidate buildCandidateProposal already
// produced. The risk gate downstream receives exactly what this function
// returns, so this is the whole containment guarantee in one place.
export function applyVetoOutcome(candidate: ModelDecisionProposal, asset: AssetSymbol, outcome: VetoOutcome, newsCount: number): ModelDecisionProposal {
  if (!outcome.veto) return candidate
  return vetoedHoldProposal(
    asset,
    `noul=${outcome.noul.toFixed(2)}, threshold=${JEV_VETO_THRESHOLD.toFixed(2)}, ${newsCount} news item${newsCount === 1 ? '' : 's'} evaluated`,
  )
}
