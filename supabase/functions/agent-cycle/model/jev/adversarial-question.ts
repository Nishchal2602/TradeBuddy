import type { AssetSymbol } from '../../../../../src/shared/market-data/types.ts'
import type { JevChoiceQuestionSpec, JevManagementQuestionSpec } from './management-question.ts'
import type { EntryOpportunityInput } from './entry-question.ts'

// Strategy V4 (intraday_ls, 2026-10-02, plan §5.1c) — the adversarial
// critique layer. A genuinely DIFFERENT question from entry-question.ts's
// entry_quality ("does this look attractive?"), not a third vote on the
// same question — orthogonal information is the whole point (plan review:
// "news veto / entry quality / adversarial critique" must each answer a
// different question, or three correlated votes tell §6 nothing new).
//
// Both questions below restate the SAME adversarial premise explicitly,
// because Jev evaluates questions in parallel and in isolation (question.
// ts's own documented API property) — nothing carries over from one
// answer to the next within a batch, so the premise cannot be stated once
// and implied for the second question.
//
// Advisory ONLY, for every profile that uses this module (currently
// intraday_ls only) — neither failure_risk nor failure_mode can ever
// block a candidate. index.ts's Pass 2 must read these outcomes without
// touching finalProposal, exactly as it already must for entry_quality;
// §6's Executed population is what eventually tests whether either
// signal predicts realized R.
//
// Jev's answer schema is a closed union of noul | choice | score (schema.
// ts) — there is no free-text answer type, so "why might this fail" is
// necessarily a Choice over a small, fixed taxonomy rather than prose.
// This is also strictly better for §6: the full probability distribution
// lets each failure mode be tested independently against realized R,
// rather than forcing a single brittle winner.

export function failureRiskQuestionId(asset: AssetSymbol): string {
  return `${asset.toLowerCase()}_failure_risk`
}

export function failureModeQuestionId(asset: AssetSymbol): string {
  return `${asset.toLowerCase()}_failure_mode`
}

// Bumped whenever this module's question wording or the failure-mode
// taxonomy changes — persisted into agent_decisions.adversarial_prompt_version,
// its own column (not folded into prompt_version/entry_prompt_version),
// so a null on an older row cleanly means "this layer did not run for
// this row," not "ran under an earlier version."
export const ADVERSARIAL_QUESTION_VERSION = 'jev-adversarial-v1'

const ADVERSARIAL_PREMISE = 'Assume this candidate is going to fail.'

const FAILURE_RISK_CRITERIA: Record<string, string> = {
  LOW: 'The supplied market context shows little to no evidence that this trade is vulnerable right now.',
  MEDIUM: 'The supplied market context shows some evidence of vulnerability, but it is not decisive either way.',
  HIGH: 'The supplied market context shows strong, specific evidence that this trade is vulnerable right now.',
}

// VALID_FAILURE_MODES is the taxonomy's one source of truth — provider.ts
// validates Jev's raw choice string against this exact list (asFailureMode),
// and the migration's CHECK constraint must list the same six values.
export const VALID_FAILURE_MODES = [
  'MOMENTUM_EXHAUSTION',
  'COUNTER_TREND_PRESSURE',
  'WEAK_VOLUME_CONFIRMATION',
  'RANGE_COMPRESSION',
  'STRUCTURE_BREAK',
  'NONE',
] as const
export type FailureMode = (typeof VALID_FAILURE_MODES)[number]

// NONE's own criteria text states its meaning precisely, because it is
// the one option genuinely easy to misread: it means ONLY "no material,
// specific vulnerability is visible in the supplied context" — it does
// NOT mean "I am unsure," and it does NOT mean "none of the other five
// categories fit but something still worries me." Collapsing those three
// distinct states into one option would make NONE's own probability
// mass uninterpretable to §6.
const FAILURE_MODE_CRITERIA: Record<FailureMode, string> = {
  MOMENTUM_EXHAUSTION: 'The move already looks stretched — the momentum driving this setup appears to be running out.',
  COUNTER_TREND_PRESSURE: 'Price action or short-horizon momentum is currently pushing against the direction this candidate needs.',
  WEAK_VOLUME_CONFIRMATION: 'Volume does not convincingly confirm the move — the setup lacks real participation behind it.',
  RANGE_COMPRESSION: 'Volatility is unusually compressed right now, raising the risk this is a false or short-lived move.',
  STRUCTURE_BREAK: 'A nearby technical level or recent price structure looks likely to reject or invalidate this setup.',
  NONE: 'There is no material, specific vulnerability visible in the supplied context. This means ONLY that — it does NOT mean "I am unsure," and it does NOT mean "none of the other categories quite fit."',
}

// Reuses the exact same opportunity object entry-question.ts's
// buildEntryQuestionsForAsset takes — this module reads only asset plus
// the optional armId/direction/bias context fields from it, never the
// Aggressive-only kind/atrTargetDistancePct/cost fields, since the
// adversarial premise is answered purely from the shared state's own
// news/position/opportunity context, not restated in the instructions.
function opportunityContextSuffix(opp: EntryOpportunityInput): string {
  return opp.armId && opp.direction && opp.bias ? ` (a ${opp.direction} ${opp.armId} candidate under ${opp.bias} bias)` : ''
}

export function buildAdversarialQuestionsForAsset(opp: EntryOpportunityInput): Record<string, JevManagementQuestionSpec> {
  const { asset } = opp
  const contextSuffix = opportunityContextSuffix(opp)
  const failureRisk: JevChoiceQuestionSpec = {
    type: 'choice',
    instructions: `${ADVERSARIAL_PREMISE} A short-horizon trading candidate was just detected on ${asset}${contextSuffix}. Based only on the supplied market context, how strong is the evidence that this trade is vulnerable right now?`,
    criteria: FAILURE_RISK_CRITERIA,
  }
  const failureMode: JevChoiceQuestionSpec = {
    type: 'choice',
    instructions: `${ADVERSARIAL_PREMISE} A short-horizon trading candidate was just detected on ${asset}${contextSuffix}. Based only on the supplied market context, what is the strongest evidence that this trade is vulnerable?`,
    criteria: FAILURE_MODE_CRITERIA,
  }
  return {
    [failureRiskQuestionId(asset)]: failureRisk,
    [failureModeQuestionId(asset)]: failureMode,
  }
}

export interface AdversarialOutcome {
  asset: AssetSymbol
  failureRisk: 'LOW' | 'MEDIUM' | 'HIGH'
  failureRiskConfidence: number
  failureRiskDistribution: Record<string, number>
  failureMode: FailureMode
  failureModeConfidence: number
  failureModeDistribution: Record<string, number>
}
