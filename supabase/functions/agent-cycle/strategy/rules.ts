import type { AssetSymbol } from '../../../../src/shared/market-data/types.ts'
import type { PositionState } from '../../../../src/shared/positions/types.ts'
import type { ModelDecisionProposal } from '../../../../src/shared/decisions/types.ts'
import type { RegimeResult } from '../../../../src/shared/strategy/types.ts'

// trading-strategy-v1.md §14-15, §20 — deterministic candidate synthesis.
// Pure: no Gemini, no Supabase, no sizing (that's the existing risk gate's
// job downstream, unchanged). This is the ONLY place `ModelDecisionProposal`
// values are constructed by strategy code rather than parsed from Gemini's
// JSON — everything downstream of the gate (planDecisionExecution, both
// atomic RPCs, the broker) neither knows nor cares that this proposal was
// synthesized rather than model-generated, by design (see index.ts's
// rewired loop, Phase 5).

// A single stable invalidation sentence, not regenerated with current
// price/MA values baked in — trading-strategy-v1.md §13: "the regime flip
// IS the thesis invalidation," a structural fact re-verified deterministically
// each cycle, not a judgment call a model needs to "reaffirm or revise."
// Every OPEN_LONG and every subsequent HOLD-while-LONG proposal for the
// same episode carries this exact text.
const LONG_INVALIDATION_TEXT = 'Daily close at or below the 50-day moving average'

// §14: "a catastrophic risk constraint... its parameters are never tuned
// for return." atrPct arrives as a PERCENTAGE-AS-NUMBER (e.g. 1.10 meaning
// 1.10% — indicators/calculate.ts's calculateATRPercent's own convention,
// `(atr / lastClose) * 100`), while stopLossPct/takeProfitPct throughout
// this codebase (ModelDecisionProposal, agent_settings bounds) are
// FRACTIONS (0.025 meaning 2.5%) — the /100 below is a real, deliberate
// unit conversion, not a stray constant.
export function stopLossPctFor(atrPct: number): number {
  return Math.max(2.0 * (atrPct / 100), 0.025)
}

// §15: "a provisional catastrophe cap... the real exit is the regime
// flip." Deliberately not clamped to agent_settings.max_take_profit_pct
// here — that clamp is the existing risk gate's job (validateStopLossTakeProfit),
// same as stopLossPctFor above; a proposal this module builds that falls
// outside configured bounds is correctly REJECTED downstream, not silently
// resized by the strategy itself (gate.ts: "must not silently transform a
// proposal without recording what happened").
export function takeProfitPctFor(stopLossPct: number): number {
  return 6.0 * stopLossPct
}

export interface CandidateInput {
  asset: AssetSymbol
  currentState: PositionState
  regime: RegimeResult
  atrPct: number
}

function holdProposal(asset: AssetSymbol, invalidation: string[], reasonText: string): ModelDecisionProposal {
  return {
    asset,
    action: 'HOLD',
    confidence: 1,
    horizonHours: null,
    reasons: [{ type: 'TECHNICAL', text: reasonText }],
    invalidation: invalidation.map((text) => ({ text })),
  }
}

function closeProposal(asset: AssetSymbol, dailyClose: number, dailyMa: number): ModelDecisionProposal {
  return {
    asset,
    action: 'CLOSE',
    confidence: 1,
    horizonHours: null,
    reasons: [{
      type: 'TECHNICAL',
      text: `Daily close ${dailyClose.toFixed(2)} at or below the 50-day MA ${dailyMa.toFixed(2)} — regime flip, thesis invalidated`,
    }],
    invalidation: [],
  }
}

function openLongProposal(
  asset: AssetSymbol,
  dailyClose: number,
  dailyMa: number,
  atrPct: number,
): ModelDecisionProposal {
  const stopLossPct = stopLossPctFor(atrPct)
  return {
    asset,
    action: 'OPEN_LONG',
    confidence: 1,
    horizonHours: null,
    reasons: [{
      type: 'TECHNICAL',
      text: `Daily close ${dailyClose.toFixed(2)} above the 50-day MA ${dailyMa.toFixed(2)}`,
    }],
    invalidation: [{ text: LONG_INVALIDATION_TEXT }],
    stopLossPct,
    takeProfitPct: takeProfitPctFor(stopLossPct),
  }
}

// The one deterministic entry point index.ts calls per asset, per cycle
// (Phase 5). Implements the full state machine from trading-strategy-v1.md
// §20 for the long/flat-only (§5) case. `confidence: 1` throughout is
// deliberate, not a placeholder: §12 removes the confidence gate entirely
// (buildRiskGateContext passes effectiveMinConfidence: 0), so this value
// is inert by construction — logged for the audit trail, gates nothing.
export function buildCandidateProposal(input: CandidateInput): ModelDecisionProposal {
  const { asset, currentState, regime, atrPct } = input

  if (currentState === 'SHORT') {
    // V1 is long/flat only (§5) and defines no regime rule for the short
    // side — a pre-existing short is never touched deterministically; it
    // exits via its own SL/TP only, same as any other open position. Not
    // expected to fire in practice: 0 open positions exist at the time V1
    // deploys, and V1 itself never opens a new short to reach this branch
    // again. Handled explicitly rather than left to fall through, so a
    // stray short can never silently reach the OPEN_LONG branch below.
    return holdProposal(asset, [], 'Existing short position — V1 is long/flat only, not evaluated by the regime rule')
  }

  if (currentState === 'LONG') {
    if (regime.regime === 'DOWN') return closeProposal(asset, regime.dailyClose, regime.dailyMa)
    return holdProposal(
      asset,
      [LONG_INVALIDATION_TEXT],
      `Daily close ${regime.dailyClose.toFixed(2)} still above the 50-day MA ${regime.dailyMa.toFixed(2)} — regime unchanged`,
    )
  }

  // FLAT.
  if (regime.regime === 'UP') return openLongProposal(asset, regime.dailyClose, regime.dailyMa, atrPct)
  return holdProposal(asset, [], `Daily close ${regime.dailyClose.toFixed(2)} at or below the 50-day MA ${regime.dailyMa.toFixed(2)} — no long eligibility`)
}

// Applied by index.ts (Phase 5) when the batched veto call returns
// veto: true for an OPEN_LONG candidate this module produced — or when
// the veto call itself (or the news it depends on) failed, which fails
// closed the same way (never silently auto-approve — trading-strategy-
// v1.md §12). Kept here rather than constructed ad hoc in index.ts: this
// module is "the ONLY place ModelDecisionProposal values are constructed
// by strategy code" (module comment above), and a vetoed candidate is
// still exactly that — a HOLD synthesized deterministically, just for a
// different reason than the FLAT+DOWN case above. No invalidation is
// carried (same as the plain FLAT hold): a vetoed OPEN_LONG never became
// a position, so there is no existing thesis to reaffirm.
export function vetoedHoldProposal(asset: AssetSymbol, rationale: string): ModelDecisionProposal {
  return holdProposal(asset, [], `Vetoed: ${rationale}`)
}
