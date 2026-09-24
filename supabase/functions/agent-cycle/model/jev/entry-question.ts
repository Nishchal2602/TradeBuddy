import type { AssetSymbol } from '../../../../../src/shared/market-data/types.ts'
import type { JevChoiceQuestionSpec, JevScoreQuestionSpec, JevManagementQuestionSpec } from './management-question.ts'

// Aggressive strategy (v3-jev-intraday-30m, 2026-09-23) — the ONLY
// questions specific to Aggressive's FLAT-asset entry path. Balanced's
// FLAT path is entirely unchanged: it still asks only the pre-existing
// veto noul question (question.ts's buildJevQuestion) — these two are
// asked ADDITIONALLY, only for a FLAT asset where a deterministic
// opportunity detector (strategy/aggressive/detectors.ts) actually
// fired. The non-negotiable rule holds exactly: Jev still cannot invent
// an entry where no detector fired — it can only judge whether a
// DETECTED opportunity is worth acting on, via a choice (never a
// direction) and a magnitude estimate (never a price).
//
// migration plan §3/§7: veto (safety) + entry_quality (Jev's own
// judgement of the detected opportunity) + expected_move (Jev's own
// prediction, kept STRUCTURALLY SEPARATE from the deterministic
// atrTargetDistancePct — conflating "the target distance the strategy
// chose" with "what Jev predicts will happen" was a real error caught
// during plan review). Either veto or a SKIP entry_quality answer can
// only ever REMOVE the candidate.

export function entryQualityQuestionId(asset: AssetSymbol): string {
  return `${asset.toLowerCase()}_entry_quality`
}

export function expectedMoveQuestionId(asset: AssetSymbol): string {
  return `${asset.toLowerCase()}_expected_move`
}

// Bumped whenever the entry_quality/expected_move question wording or the
// EXPECTED_MOVE_PCT_BY_SCORE_LEVEL table changes — persisted into
// agent_decisions.prompt_version for an Aggressive entry-normalization
// row, same discipline as JEV_QUESTION_VERSION (veto) and
// MANAGEMENT_QUESTION_VERSION (management).
export const ENTRY_QUESTION_VERSION = 'jev-entry-v1'

const ENTRY_QUALITY_CRITERIA: Record<string, string> = {
  ENTER: 'The detected opportunity is genuinely worth acting on right now, given the short-horizon context and the round-trip cost of trading it.',
  SKIP: 'The detected opportunity is not worth acting on — too small relative to cost, contradicted by other short-horizon context, or simply low quality.',
}

// Score levels for Jev's OWN prediction of the move size, kept separate
// from the deterministic atrTargetDistancePct on purpose (migration plan
// §7) — this is what later lets analysis distinguish "Jev was
// directionally/magnitude wrong" from "the deterministic target was never
// achievable given real costs," two failures with opposite remedies.
const EXPECTED_MOVE_LEVELS = [
  'Negligible — likely to be consumed by fees and slippage alone.',
  'Modest — a small move, comparable in size to the round-trip cost.',
  'Meaningful — clearly larger than the round-trip cost, worth trading.',
  'Substantial — a large move relative to typical short-horizon volatility for this asset.',
]

export function buildEntryQuestionsForAsset(asset: AssetSymbol): Record<string, JevManagementQuestionSpec> {
  const entryQuality: JevChoiceQuestionSpec = {
    type: 'choice',
    instructions: `A deterministic short-horizon opportunity was just detected on ${asset}. Given the recent price action, momentum, volatility, and cost of trading, is this genuinely worth entering right now?`,
    criteria: ENTRY_QUALITY_CRITERIA,
  }
  const expectedMove: JevScoreQuestionSpec = {
    type: 'score',
    instructions: `If a new ${asset} position were opened right now, how large a favorable move do you expect over the next 15-60 minutes?`,
    criteria: EXPECTED_MOVE_LEVELS,
  }
  return {
    [entryQualityQuestionId(asset)]: entryQuality,
    [expectedMoveQuestionId(asset)]: expectedMove,
  }
}

// Maps EXPECTED_MOVE_LEVELS' score position (0..3) to a code-defined
// percentage-as-fraction figure — Jev is never asked for a raw number,
// same discipline management-question.ts's magnitudeFromScore already
// applies to ADD/REDUCE. Pre-registered, not tuned: roughly centered on
// each level's own description, in the same fraction units as
// estimatedRoundTripCostPct (0.003 means 0.3%).
export const EXPECTED_MOVE_PCT_BY_SCORE_LEVEL: readonly number[] = [0.001, 0.003, 0.008, 0.020]

export function expectedMovePctFromScore(score: number): number {
  const clamped = Math.min(Math.max(score, 0), EXPECTED_MOVE_PCT_BY_SCORE_LEVEL.length - 1)
  return EXPECTED_MOVE_PCT_BY_SCORE_LEVEL[Math.round(clamped)]!
}

// What strategy/registry.ts's Aggressive runtime builds for a FLAT asset
// with a detected opportunity (strategy/aggressive/detectors.ts) — the
// SAME asset also appears in the ordinary vetoCandidates list (the news
// noul question is unchanged and reused), so this is additive state and
// additive questions, never a replacement for the veto path.
export interface EntryOpportunityInput {
  asset: AssetSymbol
  kind: 'MOMENTUM_BREAKOUT' | 'PULLBACK_CONTINUATION'
  atrTargetDistancePct: number
  estimatedRoundTripCostPct: number
  ret15mPct: number
  ret30mPct: number
  ret60mPct: number
  realizedVol5m: number
  volumeTrendRatio: number
  sampledDayHighPct: number
  sampledDayLowPct: number
}

export interface EntryOutcome {
  asset: AssetSymbol
  enter: boolean
  // Raw confidence on the entry_quality Choice answer — persisted
  // verbatim (same containment-not-suppression reasoning as every other
  // raw confidence value in this codebase); nothing gates on it.
  enterConfidence: number
  expectedMovePct: number
}

