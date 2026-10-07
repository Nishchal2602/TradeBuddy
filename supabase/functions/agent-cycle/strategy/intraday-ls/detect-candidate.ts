import type { NormalizedMarketData } from '../../../../../src/shared/market-data/types.ts'
import type { ModelDecisionProposal } from '../../../../../src/shared/decisions/types.ts'
import { computeStopLossTakeProfitPrices } from '../../../../../src/shared/risk/sl-tp.ts'
import type { IntradayLsConfig } from '../../../../../src/shared/strategy/config-schema.ts'
import { checkStrategyDataSufficiency, clearsEntryTradeabilityFloor, intradayFeaturesFor, managementAtrPctFor, protectionForEntry } from '../registry.ts'
import { stopLossPctFor, takeProfitPctFor } from '../rules.ts'
import type { IntradayMarketData } from '../aggressive/types.ts'
import { evaluateBias } from './bias.ts'
import type { Bias } from './bias.ts'
import { detectIntradayLsOpportunity, isOpportunityStillValid } from './detectors.ts'
import type { ArmId, Direction } from './detectors.ts'
import { shouldEmitOpportunity } from './lifecycle.ts'

// CFG-1 Stage 2 (2026-10-06) — the pure extraction of agent-cycle/index.ts's
// intraday_ls Pass-1 detection block (previously inlined at index.ts:854-974),
// so the replay harness can reuse this EXACT logic rather than reimplement
// it (project-overview.md's Backtest/Replay Scope boundary: "not a second
// implementation of trading logic"). Zero DB access — the one DB read the
// inlined block needed (readLastConsumedOpportunityBarTs) stays the
// caller's job, same split as every other pure module in this codebase
// (position-monitor/plan.ts, cycle/build-context.ts, cycle/plan-decision.ts,
// this directory's own lifecycle.ts) — the caller passes its already-
// resolved value in as lastConsumedBarTs, exactly like shouldEmitOpportunity
// already receives it today.
//
// Every function called below (checkStrategyDataSufficiency, evaluateBias,
// detectIntradayLsOpportunity, isOpportunityStillValid, protectionForEntry,
// clearsEntryTradeabilityFloor, shouldEmitOpportunity) is unchanged and
// called in the exact same order with the exact same arguments the inlined
// block used — this is a MOVE, not a rewrite. index.ts's own
// behavior-neutrality proof is the full test suite passing unedited plus
// one live manual cycle reproducing identical row-level output (CFG-1
// Stage 2 verification steps 1-2).

export interface DetectCandidateInput {
  assetMarketData: NormalizedMarketData
  intraday: IntradayMarketData | undefined
  // activeIntradayLsConfig?.config, exactly as index.ts already reads it.
  config: IntradayLsConfig | undefined
  // readLastConsumedOpportunityBarTs(supabase, portfolio.id, asset)'s
  // result — the caller's job, never this function's. For replay, this
  // must be bounded to the replayed row's OWN decided_at (see the Stage 2
  // plan's live-input inventory) — this function has no opinion on how
  // the caller derived the value, only on comparing it.
  lastConsumedBarTs: string | null
  feeBps: number
  slippageBps: number
}

export interface DetectCandidateResult {
  regimeState: Bias | null | undefined
  eligibleArms: ArmId[] | null | undefined
  noCandidateReason: 'data_insufficient' | 'regime_null' | 'no_arm_triggered' | 'cost_gate' | 'opportunity_consumed' | 'signal_stale' | null | undefined
  opportunityContext?: { armId: ArmId; bias: Bias; direction: Direction; opportunityBarTs: string }
  candidate?: ModelDecisionProposal
  computedPrices?: { stopLossPrice: number; takeProfitPrice: number }
}

export function detectCandidate(input: DetectCandidateInput): DetectCandidateResult {
  const { assetMarketData, intraday, config: policyConfig, lastConsumedBarTs, feeBps, slippageBps } = input
  const asset = assetMarketData.asset

  let regimeState: DetectCandidateResult['regimeState']
  let eligibleArms: DetectCandidateResult['eligibleArms']
  let noCandidateReason: DetectCandidateResult['noCandidateReason']
  let opportunityContext: DetectCandidateResult['opportunityContext']
  let candidate: DetectCandidateResult['candidate']
  let computedPrices: DetectCandidateResult['computedPrices']

  const sufficiency = checkStrategyDataSufficiency('intraday_ls', assetMarketData, intraday)
  if (!sufficiency.ok || !intraday) {
    noCandidateReason = 'data_insufficient'
    return { regimeState, eligibleArms, noCandidateReason }
  }

  const bias = evaluateBias(assetMarketData.dailyCloseSeries, assetMarketData.candles.map((c) => c.close))
  regimeState = bias
  if (!bias) {
    noCandidateReason = 'regime_null'
    return { regimeState, eligibleArms, noCandidateReason }
  }

  eligibleArms = policyConfig?.directionPolicy[bias] ?? null
  const features = intradayFeaturesFor(intraday)
  const detected = detectIntradayLsOpportunity(
    bias,
    intraday.ohlc30m,
    { ret60mPct: features.ret60mPct, volumeTrendRatio: features.volumeTrendRatio },
    assetMarketData,
    policyConfig
      ? {
          directionPolicy: policyConfig.directionPolicy,
          arms: policyConfig.arms,
          minVolumeTrendRatio: policyConfig.breakoutMinVolumeTrendRatio,
          fadeThresholds: { oversold: policyConfig.fadeRsiOversold, overbought: policyConfig.fadeRsiOverbought, rangeAtrMultiple: policyConfig.fadeRangeAtrMultiple },
        }
      : undefined,
  )
  if (!detected) {
    noCandidateReason = 'no_arm_triggered'
    return { regimeState, eligibleArms, noCandidateReason }
  }

  const atr30Pct = managementAtrPctFor('intraday_ls', assetMarketData, intraday)
  const { stopLossPct, takeProfitPct } = protectionForEntry('intraday_ls', atr30Pct, stopLossPctFor, takeProfitPctFor, detected.armId)
  const estimatedRoundTripCostPct = (2 * (feeBps + slippageBps)) / 10_000
  if (!clearsEntryTradeabilityFloor('intraday_ls', 0, estimatedRoundTripCostPct, stopLossPct)) {
    noCandidateReason = 'cost_gate'
    return { regimeState, eligibleArms, noCandidateReason }
  }

  if (!shouldEmitOpportunity(detected.detectedAtBarTs, lastConsumedBarTs)) {
    noCandidateReason = 'opportunity_consumed'
    return { regimeState, eligibleArms, noCandidateReason }
  }

  if (
    policyConfig?.signalDriftRuleEnforced &&
    !isOpportunityStillValid(detected.triggerBarClose, assetMarketData.price, stopLossPct, policyConfig.signalDriftMaxFraction)
  ) {
    noCandidateReason = 'signal_stale'
    return { regimeState, eligibleArms, noCandidateReason }
  }

  // arm_id/bias/opportunity_bar_ts persist on the main row regardless of
  // what happens next (that gating is keyed on opportunityContext alone,
  // below — never on candidate), so the opportunity is never silently
  // lost even if it's not promoted.
  opportunityContext = { armId: detected.armId, bias, direction: detected.direction, opportunityBarTs: detected.detectedAtBarTs }
  computedPrices = computeStopLossTakeProfitPrices(detected.direction, assetMarketData.price, stopLossPct, takeProfitPct)

  // CFG-1 Stage 1B — "short reachable but disabled": a detected short is
  // NOT promoted to a live trade proposal when the active config's
  // shortEnabled=false. Leaving `candidate` unset here is deliberately the
  // ONLY change needed — see index.ts's own callers, which already key on
  // this exact field's presence.
  if (!(detected.direction === 'short' && policyConfig && !policyConfig.shortEnabled)) {
    candidate = {
      asset,
      action: detected.direction === 'long' ? 'OPEN_LONG' : 'OPEN_SHORT',
      confidence: 1,
      horizonHours: null,
      reasons: [{ type: 'TECHNICAL', text: `intraday_ls ${detected.armId} detected under ${bias} bias` }],
      invalidation: [{ text: 'Managed by the position-monitor exit set (stop-loss/take-profit/giveback/time-stop), not the daily trend regime' }],
      stopLossPct,
      takeProfitPct,
    }
  }

  // A real candidate was built (or deliberately suppressed above) —
  // no_candidate_reason stays null either way: an opportunity WAS detected
  // this cycle, which is what that field means.
  return { regimeState, eligibleArms, noCandidateReason, opportunityContext, candidate, computedPrices }
}
