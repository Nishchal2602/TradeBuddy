import type { AssetSymbol } from '../../../../../src/shared/market-data/types.ts'
import type { Direction } from '../../../../../src/shared/positions/types.ts'
import type { ArmId } from '../../strategy/intraday-ls/detectors.ts'
import type { Bias } from '../../strategy/intraday-ls/bias.ts'
import type { JevChoiceQuestionSpec, JevScoreQuestionSpec, JevManagementQuestionSpec } from './management-question.ts'
import { hashPromptContent } from './prompt-hash.ts'

// Aggressive strategy (v3-jev-intraday-30m, 2026-09-23) — originally the
// ONLY questions specific to a FLAT-asset entry path; Strategy V4
// (intraday_ls, 2026-10-02, plan §5.1b/§5.2 point 2) now shares this same
// module, in ADVISORY mode instead of Aggressive's BLOCKING mode (see
// `agent_decisions.entry_gate_mode`, set by the caller in index.ts, never
// decided in here). Balanced's FLAT path is entirely unchanged: it still
// asks only the pre-existing veto noul question (question.ts's
// buildJevQuestion) — these two are asked ADDITIONALLY, only for a FLAT
// asset where a deterministic opportunity detector (strategy/aggressive/
// detectors.ts or strategy/intraday-ls/detectors.ts) actually fired. The
// non-negotiable rule holds exactly: Jev still cannot invent an entry
// where no detector fired — it can only judge whether a DETECTED
// opportunity is worth acting on, via a choice (never a direction) and a
// magnitude estimate (never a price).
//
// migration plan §3/§7: veto (safety) + entry_quality (Jev's own
// judgement of the detected opportunity) + expected_move (Jev's own
// prediction, kept STRUCTURALLY SEPARATE from the deterministic
// atrTargetDistancePct — conflating "the target distance the strategy
// chose" with "what Jev predicts will happen" was a real error caught
// during plan review). Either veto or a SKIP entry_quality answer can
// only ever REMOVE the candidate — and for intraday_ls specifically, in
// advisory mode, not even that (SKIP is recorded, not acted on).

export function entryQualityQuestionId(asset: AssetSymbol): string {
  return `${asset.toLowerCase()}_entry_quality`
}

export function expectedMoveQuestionId(asset: AssetSymbol): string {
  return `${asset.toLowerCase()}_expected_move`
}

// Bumped whenever the entry_quality/expected_move question wording or the
// EXPECTED_MOVE_PCT_BY_SCORE_LEVEL table changes — persisted into
// agent_decisions.{entry_prompt_version} (and, for the legacy Aggressive
// path, still prompt_version too), same discipline as JEV_QUESTION_VERSION
// (veto) and MANAGEMENT_QUESTION_VERSION (management). v1 -> v4-entry-ls-1
// (2026-10-02, plan §5.2 point 2): buildEntryQuestionsForAsset now takes
// the whole opportunity object and conditionally names armId/direction/
// bias when present — Aggressive's own candidates never set those three
// fields, so its question TEXT is unchanged (a dedicated regression test
// asserts byte-identical output), but the version bumps anyway since the
// wording logic itself changed, matching this file's own documented
// convention ("bumped whenever ... wording ... changes").
export const ENTRY_QUESTION_VERSION = 'v4-entry-ls-1'

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

// Strategy V4 (2026-10-02) — armId/direction/bias are present together or
// not at all (intraday_ls only); when absent, contextSuffix is '' and the
// instructions text is BYTE-IDENTICAL to the pre-2026-10-02 Aggressive
// wording — a dedicated regression test pins this exactly.
function opportunityContextSuffix(opp: EntryOpportunityInput): string {
  return opp.armId && opp.direction && opp.bias ? ` (a ${opp.direction} ${opp.armId} candidate under ${opp.bias} bias)` : ''
}

export function buildEntryQuestionsForAsset(opp: EntryOpportunityInput): Record<string, JevManagementQuestionSpec> {
  const { asset } = opp
  const contextSuffix = opportunityContextSuffix(opp)
  const entryQuality: JevChoiceQuestionSpec = {
    type: 'choice',
    instructions: `A deterministic short-horizon opportunity was just detected on ${asset}${contextSuffix}. Given the recent price action, momentum, volatility, and cost of trading, is this genuinely worth entering right now?`,
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

// Tier 0 provenance (2026-10-03, prompt-hash.ts's own comment) — a
// content hash of this module's actual rendered prompt text, covering
// both branches `opportunityContextSuffix` produces: Aggressive-shaped
// (no armId/direction/bias, contextSuffix='') and V4-shaped (all three
// present). All other fixture fields are held fixed since nothing else
// in this file varies the WORDING — only the context trio's presence
// does. prompt-provenance.test.ts pins this against ENTRY_QUESTION_VERSION.
export async function entryQuestionPromptFingerprint(): Promise<string> {
  const base = {
    asset: 'BTC' as const,
    atrTargetDistancePct: 0.02,
    estimatedRoundTripCostPct: 0.003,
    ret15mPct: 0.1,
    ret30mPct: 0.2,
    ret60mPct: 0.3,
    realizedVol5m: 0.01,
    volumeTrendRatio: 1.1,
    sampledDayHighPct: 1,
    sampledDayLowPct: -1,
  }
  const aggressiveShaped = buildEntryQuestionsForAsset(base)
  const v4Shaped = buildEntryQuestionsForAsset({ ...base, armId: 'pullback_long', direction: 'long', bias: 'LONG' })
  return hashPromptContent([JSON.stringify(aggressiveShaped), JSON.stringify(v4Shaped)])
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
// with a detected opportunity (strategy/aggressive/detectors.ts), OR what
// index.ts's intraday_ls Pass 1 builds for a V4 opportunity (strategy/
// intraday-ls/detectors.ts) — the SAME asset also appears in the ordinary
// vetoCandidates list (the news noul question is unchanged and reused),
// so this is additive state and additive questions, never a replacement
// for the veto path.
export interface EntryOpportunityInput {
  asset: AssetSymbol
  // Aggressive-only — intraday_ls has no detector 'kind', only
  // armId/direction/bias below.
  kind?: 'MOMENTUM_BREAKOUT' | 'PULLBACK_CONTINUATION'
  atrTargetDistancePct: number
  estimatedRoundTripCostPct: number
  ret15mPct: number
  ret30mPct: number
  ret60mPct: number
  realizedVol5m: number
  volumeTrendRatio: number
  sampledDayHighPct: number
  sampledDayLowPct: number
  // Strategy V4 (intraday_ls, 2026-10-02, plan §5.1b/§5.2 point 2) — all
  // three present together or not at all. Gives entry_quality and the
  // adversarial questions (adversarial-question.ts) real context instead
  // of asking direction-blind, which was the exact class of defect the
  // direction-aware veto fix (§5.1a) already closed on the noul question.
  armId?: ArmId
  direction?: Direction
  bias?: Bias
}

export interface EntryOutcome {
  asset: AssetSymbol
  enter: boolean
  // Raw confidence on the entry_quality Choice answer — persisted
  // verbatim (same containment-not-suppression reasoning as every other
  // raw confidence value in this codebase); nothing gates on it.
  enterConfidence: number
  // Strategy V4 (2026-10-02, plan §5.1b review item 1) — the FULL
  // probability distribution, not just the winning choice. §6 needs this
  // to test, e.g., "does a high ENTER probability specifically predict
  // realized R" independent of the thresholded boolean `enter` above.
  enterDistribution: Record<string, number>
  expectedMovePct: number
  expectedMoveConfidence: number
  // Score distribution, keyed by Jev's own stringified level index
  // ('0'..'3'), NOT by EXPECTED_MOVE_LEVELS' text — the row's own
  // entry_prompt_version is what pins which EXPECTED_MOVE_PCT_BY_SCORE_LEVEL
  // table those indices meant at the time.
  expectedMoveDistribution: Record<string, number>
}

