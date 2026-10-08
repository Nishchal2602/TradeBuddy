import { evaluateTrendRegime } from '../strategy/regime.ts'
import { TREND_MA_LOOKBACK_DAYS } from '../../../../src/shared/strategy/types.ts'
import type { Bias } from '../strategy/intraday-ls/bias.ts'
import type { ArmId, Direction } from '../strategy/intraday-ls/detectors.ts'
import { computeIntradayLsProtection, passesIntradayLsCostGate } from '../strategy/intraday-ls/protection.ts'
import { computeStopLossTakeProfitPrices } from '../../../../src/shared/risk/sl-tp.ts'
import { calculateATRPercent } from '../indicators/calculate.ts'
import type { IntradayLsConfig } from '../../../../src/shared/strategy/config-schema.ts'
import type { ModelDecisionProposal } from '../../../../src/shared/decisions/types.ts'
import { checkHistoricalDataSufficiency } from './historical-detect.ts'
import type { DetectHistoricalCandidateInput, HistoricalDetectResult } from './historical-detect.ts'

// RESEARCH-1 (2026-10-08, STRAT-1 P5, stage R4) — the pre-registered
// variant mechanisms the plan's own first-questions list calls for, none
// of them touching live strategy code:
//
// 1. resolveDailyOnlyBias -- the daily regime leg ALONE (no 4h
//    confirmation), to test whether that confirmation leg earns its
//    place (CFG-1's own F2 finding: measured at zero edge, pointing the
//    wrong way). Injected into detectHistoricalCandidate via its own
//    `resolveBias` parameter -- evaluateBias itself is untouched.
// 2. computeIntradayLsProtectionFromConfig -- alternative stop/target
//    geometry, read from IntradayLsConfig's own (currently config-schema
//    -only, not-yet-live-wired) geometry fields, injected via
//    detectHistoricalCandidate's `computeProtection` parameter.
//    strategy/intraday-ls/protection.ts's own hardcoded constants are
//    never touched -- config-schema.ts's own comment already documents
//    that wiring config into that module live is "explicit FUTURE WORK,"
//    and this function does not pre-empt that decision.
// 3. buildRandomEntryDetector -- "each arm vs a random-entry baseline"
//    (the plan's own item 1): an UNCONDITIONAL entry (no signal, no
//    bias, no arm) every time the asset is flat and data is sufficient,
//    using the same breakout-family default geometry as a neutral
//    stand-in (no real arm id applies) -- the same baseline CONCEPT
//    P3's shadow-baseline.ts already established for live shadow
//    logging, adapted here into something an actual backtest can hold a
//    position against. Injected as a whole detectFn, since it bypasses
//    bias/eligible-arms/opportunity-consumption entirely (none of those
//    concepts apply to an unconditional control).

export function resolveDailyOnlyBias(dailyCloses: { timestamp: string; close: number }[], _h4Closes: number[]): Bias | null {
  if (dailyCloses.length < TREND_MA_LOOKBACK_DAYS) return null
  const regime = evaluateTrendRegime(dailyCloses)
  return regime.regime === 'UP' ? 'LONG' : 'SHORT'
}

export function computeIntradayLsProtectionFromConfig(config: IntradayLsConfig): (armId: ArmId, atr30Pct: number) => { stopLossPct: number; takeProfitPct: number } {
  return (armId, atr30Pct) => {
    const atrFraction = atr30Pct / 100
    const stopLossPct = Math.max(config.stopAtrMultiple * atrFraction, config.stopFloorPct)
    const rewardRiskRatio = config.arms[armId]?.rewardRiskRatio ?? (armId.startsWith('fade') ? 1.5 : 2.0)
    return { stopLossPct, takeProfitPct: rewardRiskRatio * stopLossPct }
  }
}

export function buildRandomEntryDetector(direction: Direction, shortEnabled: boolean): (input: DetectHistoricalCandidateInput) => HistoricalDetectResult {
  const pseudoArmId: ArmId = direction === 'long' ? 'breakout_long' : 'breakout_short'
  return (input) => {
    const { snapshot, feeBps, slippageBps } = input
    const sufficiency = checkHistoricalDataSufficiency(snapshot)
    if (!sufficiency.ok) return { regimeState: null, eligibleArms: null, noCandidateReason: 'data_insufficient' }
    if (direction === 'short' && !shortEnabled) {
      // Measurable (sufficiency/cost-gate evaluated identically), never
      // executed -- same "reachable but disabled" convention CFG-1 Stage
      // 1B established for the real arms.
      return { regimeState: null, eligibleArms: null, noCandidateReason: null }
    }

    const atr30Pct = calculateATRPercent([...snapshot.bars30m], 14)
    const { stopLossPct, takeProfitPct } = computeIntradayLsProtection(pseudoArmId, atr30Pct)
    const estimatedRoundTripCostPct = (2 * (feeBps + slippageBps)) / 10_000
    if (!passesIntradayLsCostGate(estimatedRoundTripCostPct, stopLossPct)) {
      return { regimeState: null, eligibleArms: null, noCandidateReason: 'cost_gate' }
    }

    const computedPrices = computeStopLossTakeProfitPrices(direction, snapshot.price, stopLossPct, takeProfitPct)
    const candidate: ModelDecisionProposal = {
      asset: snapshot.asset,
      action: direction === 'long' ? 'OPEN_LONG' : 'OPEN_SHORT',
      confidence: 1,
      horizonHours: null,
      reasons: [{ type: 'TECHNICAL', text: 'random-entry baseline (unconditional, no signal) -- historical replay' }],
      invalidation: [{ text: 'Managed by the deterministic exit set (stop-loss/take-profit/time-stop)' }],
      stopLossPct,
      takeProfitPct,
    }
    return {
      regimeState: null,
      eligibleArms: null,
      noCandidateReason: null,
      opportunityContext: { armId: pseudoArmId, bias: 'NEUTRAL', direction, opportunityBarTs: snapshot.asOfIso },
      candidate,
      computedPrices,
    }
  }
}
