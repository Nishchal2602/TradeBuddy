import type { NormalizedMarketData, OhlcCandle } from '../../../../../src/shared/market-data/types.ts'
import type { ArmFamily, ArmId, BreakoutConfirmation, FadeThresholds, IntradayLsOpportunity } from './detectors.ts'
import { armFamilyOf, detectBreakout, detectFadeOpportunity, detectPullback } from './detectors.ts'

// STRAT-1 P3 (2026-10-08, "Event-keyed shadows with a baseline") — runs all
// six arm detectors UNGATED by bias, direction-enablement, or
// arm-enablement, so a market edge the real candidate never saw (because
// bias/config blocked it before detection) is still observed and logged.
// Deliberately ADDITIVE and SEPARATE from detect-candidate.ts/detectCandidate
// — the real candidate's own code path is never on this module's call
// graph, which is a STRONGER behavior-neutrality guarantee than the plan's
// own literal wording ("replace the single call... apply bias as a
// post-filter"): the real candidate cannot regress from a bug here, because
// this module is never on its call path. Every detector call below is pure
// and side-effect-free (the identical functions detectCandidate itself
// calls), so evaluating e.g. detectBreakout('short', ...) under a
// LONG-biased cycle costs nothing and changes nothing about what actually
// trades.

export const SHADOW_DETECTOR_VERSION = 'shadow-v1'

export type ShadowCause = 'taken' | 'bias_blocked' | 'arm_disabled' | 'direction_disabled' | 'lower_priority'

export interface ShadowOpportunity extends IntradayLsOpportunity {
  armFamily: ArmFamily
  shadowCause: ShadowCause
}

export interface DetectAllOpportunitiesInput {
  bars30m: readonly OhlcCandle[]
  breakoutConfirmation: BreakoutConfirmation
  marketData: NormalizedMarketData
  // directionPolicy[bias] for the cycle's OWN resolved bias — what the
  // real candidate's own eligibility check (detectIntradayLsOpportunity)
  // used. Passed in rather than re-resolved here, so this module never
  // forms its own opinion about direction policy.
  eligibleArms: ArmId[]
  arms?: Partial<Record<ArmId, { enabled: boolean }>>
  shortEnabled: boolean
  minVolumeTrendRatio?: number | null
  fadeThresholds?: FadeThresholds
  // The real candidate's own armId this cycle, if any — so the identical
  // market event detect-candidate.ts already promoted is classified
  // 'taken' here, rather than re-reported as a redundant, confusing
  // "blocked" shadow of itself.
  takenArmId?: ArmId
}

function isArmEnabled(armId: ArmId, arms: DetectAllOpportunitiesInput['arms']): boolean {
  return arms?.[armId]?.enabled ?? true
}

// Bias is intentionally NOT a parameter here beyond what eligibleArms
// already encodes — classification needs only "was this arm eligible",
// never the bias VALUE itself (that's bias_resolved, a column the caller
// persists directly from detectCandidate's own result, never re-derived).
export function detectAllOpportunities(input: DetectAllOpportunitiesInput): ShadowOpportunity[] {
  const { bars30m, breakoutConfirmation, marketData, eligibleArms, arms, shortEnabled, minVolumeTrendRatio, fadeThresholds, takenArmId } = input

  const raw: (IntradayLsOpportunity | null)[] = [
    detectBreakout('long', bars30m, breakoutConfirmation, minVolumeTrendRatio),
    detectBreakout('short', bars30m, breakoutConfirmation, minVolumeTrendRatio),
    detectPullback('long', bars30m),
    detectPullback('short', bars30m),
    // fade_long/fade_short are mutually exclusive WITHIN one call
    // (detectFadeOpportunity's own RSI<=30-vs->=70 branches) — pass
    // 'NEUTRAL' explicitly (its own hard bias gate, detectors.ts:214)
    // rather than editing that guard, per the plan's own instruction.
    detectFadeOpportunity('NEUTRAL', marketData, fadeThresholds),
  ]

  return raw
    .filter((o): o is IntradayLsOpportunity => o !== null)
    .map((hit) => {
      const armEnabled = isArmEnabled(hit.armId, arms)
      const biasEligible = eligibleArms.includes(hit.armId)
      const directionBlocked = hit.direction === 'short' && !shortEnabled

      let shadowCause: ShadowCause
      if (hit.armId === takenArmId) shadowCause = 'taken'
      else if (directionBlocked) shadowCause = 'direction_disabled'
      else if (!armEnabled) shadowCause = 'arm_disabled'
      else if (!biasEligible) shadowCause = 'bias_blocked'
      // Reachable only when BOTH trend arms for one direction fire in the
      // same cycle (e.g. breakout_long and pullback_long both edge this
      // cycle) — detectIntradayLsOpportunity's own breakout-before-
      // pullback priority (detectors.ts) means only one is ever promoted
      // to the real candidate; the other is fully eligible and enabled,
      // just structurally never reached. Mislabeling it 'bias_blocked'
      // (bias did not block it) or 'arm_disabled' (config did not disable
      // it) would be false.
      else shadowCause = 'lower_priority'

      return { ...hit, armFamily: armFamilyOf(hit.armId), shadowCause }
    })
}
