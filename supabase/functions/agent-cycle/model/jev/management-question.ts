import type { AssetSymbol } from '../../../../../src/shared/market-data/types.ts'
import type { Direction } from '../../../../../src/shared/positions/types.ts'
import type { JevNewsItem, JevPositionSnapshot, JevState } from './question.ts'
import type { VetoCandidateInput } from '../payload.ts'
import { buildJevState } from './question.ts'

// Phase 2 (2026-09-22) — "Jev as a portfolio-management decision layer."
// This module owns the OPEN-position questions only; question.ts's
// existing veto question (FLAT candidates) is completely unchanged and
// untouched by this migration. Both question sets share ONE request
// (buildPortfolioState below combines them into one JevState) — the API
// contract confirms a single request's `questions` map can freely mix
// noul/choice/score, and speculative fan-out (asking questions whose
// answer might not end up mattering) costs negligible extra latency.

// ---------------------------------------------------------------------------
// Provisional constants — versioned together, same discipline as
// question.ts's JEV_VETO_THRESHOLD/JEV_QUESTION_VERSION pair.
// ---------------------------------------------------------------------------

// The take-profit MOVE_CLOSER/MOVE_OUT step, in units of ATR (a price, not
// a percentage) — see buildProtectionUpdate in apply-management.ts for the
// exact formula. 1.0x is a deliberately modest, unit-consistent starting
// step; ships provisional, not tuned against any data. Confirm/adjust per
// the migration plan's own open-decisions list before treating this as
// settled.
export const TP_STEP_ATR_MULTIPLE = 1.0

// Score answers are probability-weighted POSITIONS on an ordered scale
// (0..levels.length-1), not raw percentages — TypeSafe's own guidance:
// "use scores to rank items or round to the nearest integer when binary
// decisions are needed." Rounding to the nearest level, then mapping that
// level to a fraction in code, is exactly that pattern. Jev is never asked
// for a number directly — these fractions are code-defined, not model-
// proposed (see apply-management.ts's own comment on the sizing boundary).
//
// ADD: fraction of the risk-derived headroom the gate computes
// (deriveRiskBasedNotional against the EXISTING stop) — see gate.ts's
// evaluateAdd. 1.00 at the top level is deliberate: an ADD can use the
// full risk-derived room, unlike REDUCE (below), which never reaches 100%
// by design (a 100%-equivalent reduce is a CLOSE, not a REDUCE — see the
// module comment on cycle/apply-management.ts).
export const ADD_MAGNITUDE_BY_SCORE_LEVEL: readonly number[] = [0.25, 0.50, 1.00]

// REDUCE: fraction of the CURRENT quantity. Deliberately never reaches
// 1.00 — a magnitude resolving to "the whole position" is intentionally a
// CLOSE, not a REDUCE (positions_qty_positive would reject a REDUCE that
// zeroes the position anyway; normalizing to CLOSE upstream keeps the
// decision feed and trades.intent honest about what actually happened).
export const REDUCE_MAGNITUDE_BY_SCORE_LEVEL: readonly number[] = [0.25, 0.50, 0.75]

export function magnitudeFromScore(score: number, levels: readonly number[]): number {
  const clamped = Math.min(Math.max(score, 0), levels.length - 1)
  const levelIndex = Math.round(clamped)
  return levels[levelIndex]!
}

// Bumped whenever question wording, the ATR step multiple, or the
// magnitude tables change — persisted alongside JEV_QUESTION_VERSION in
// agent_decisions.prompt_version so a historical row stays interpretable
// under whichever version actually produced it.
export const MANAGEMENT_QUESTION_VERSION = `jev-management-v1/atr${TP_STEP_ATR_MULTIPLE.toFixed(1)}`

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
//
// Field-by-field send/never-send list (migration plan §8):
//
// SENT: direction, entryPrice, currentPrice, quantity, notionalUsd,
// unrealizedPnlPct/Usd, estimatedRoundTripCostPct, heldHours,
// stopLossPrice/takeProfitPrice, distanceToStopPct/TakeProfitPct, plus the
// SAME news evidence the veto question already sends for that asset.
//
// NEVER SENT: API keys, user/portfolio/run/position ids, cash, NAV, or
// any other-asset's exposure (a management question is scoped to ONE
// position; cross-asset portfolio context is deliberately NOT given to
// Jev — the deterministic gate is the sole owner of cross-asset risk,
// exactly as it already is for OPEN's cross-asset caps).

export interface ManagementCandidateInput {
  asset: AssetSymbol
  direction: Direction
  entryPrice: number
  currentPrice: number
  quantity: number
  stopLossPrice: number
  takeProfitPrice: number
  heldHours: number
  // Needed only to compute estimatedRoundTripCostPct — never sent as raw
  // bps fields themselves (the state carries the derived percentage, not
  // the fee-schedule internals).
  feeBps: number
  slippageBps: number
  // ATR%, already computed by indicators/calculate.ts — reused here for
  // the TP step (apply-management.ts) and sent in the state so Jev's own
  // reasoning about volatility is grounded in the same number code uses.
  atrPct: number
  news: VetoCandidateInput['news']
}

function buildPositionSnapshot(candidate: ManagementCandidateInput): JevPositionSnapshot {
  const { direction, entryPrice, currentPrice, quantity, stopLossPrice, takeProfitPrice, feeBps, slippageBps, heldHours } = candidate

  const unrealizedPnlPct = direction === 'long'
    ? (currentPrice - entryPrice) / entryPrice
    : (entryPrice - currentPrice) / entryPrice
  const unrealizedPnlUsd = direction === 'long'
    ? (currentPrice - entryPrice) * quantity
    : (entryPrice - currentPrice) * quantity

  // A full round trip pays fee + slippage on BOTH the entry already paid
  // and the eventual exit — 2x(feeBps+slippageBps), expressed as a
  // fraction of notional. Deliberately included so Jev can reason about
  // whether a gain survives costs (migration plan §12) rather than
  // treating raw unrealizedPnlPct as the whole economic picture.
  const estimatedRoundTripCostPct = (2 * (feeBps + slippageBps)) / 10_000

  return {
    direction,
    entryPrice,
    currentPrice,
    quantity,
    notionalUsd: quantity * currentPrice,
    unrealizedPnlPct,
    unrealizedPnlUsd,
    estimatedRoundTripCostPct,
    heldHours,
    stopLossPrice,
    takeProfitPrice,
    distanceToStopPct: Math.abs(currentPrice - stopLossPrice) / currentPrice,
    distanceToTakeProfitPct: Math.abs(takeProfitPrice - currentPrice) / currentPrice,
  }
}

// Combines a cycle's FLAT-candidate veto state (question.ts's existing
// buildJevState) with OPEN-position management state into ONE shared
// JevState — this is what makes "one request per cycle" true even when a
// cycle has BOTH a FLAT asset needing a veto and an OPEN asset needing
// management. An asset appearing in both lists would be a caller bug
// (invariant: one net position per asset, so an asset is FLAT-with-
// candidate XOR OPEN, never both) — not specially guarded against here,
// since the caller (agent-cycle/index.ts) already partitions assets by
// position state before either list is built.
export function buildPortfolioState(
  vetoCandidates: VetoCandidateInput[],
  managementCandidates: ManagementCandidateInput[],
  navUsd: number,
  availableCashUsd: number,
  totalExposurePct: number,
  nowIso: string,
): JevState {
  const base = buildJevState(vetoCandidates, nowIso)
  const assets: JevState['assets'] = { ...base.assets }
  for (const candidate of managementCandidates) {
    assets[candidate.asset] = {
      news: candidate.news.map((n) => ({ source: n.source, headline: n.headline, summary: n.summary, publishedAt: n.publishedAt, ageMinutes: n.ageMinutes })) as JevNewsItem[],
      position: buildPositionSnapshot(candidate),
    }
  }
  // Portfolio-level fields only make sense (and are only sent) when there
  // is at least one position to manage — a pure veto-only cycle keeps the
  // exact pre-Phase-2, narrower state shape.
  if (managementCandidates.length === 0) return { evaluatedAt: base.evaluatedAt, assets }
  return { evaluatedAt: base.evaluatedAt, navUsd, availableCashUsd, totalExposurePct, assets }
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export interface JevChoiceQuestionSpec {
  type: 'choice'
  instructions: string
  criteria: Record<string, string>
}

export interface JevScoreQuestionSpec {
  type: 'score'
  instructions: string
  criteria: string[]
}

export type JevManagementQuestionSpec = JevChoiceQuestionSpec | JevScoreQuestionSpec

function assetTag(asset: AssetSymbol): string {
  return asset.toLowerCase()
}

export function managementActionQuestionId(asset: AssetSymbol): string {
  return `${assetTag(asset)}_action`
}
export function addConvictionQuestionId(asset: AssetSymbol): string {
  return `${assetTag(asset)}_add_conviction`
}
export function reduceMagnitudeQuestionId(asset: AssetSymbol): string {
  return `${assetTag(asset)}_reduce_magnitude`
}
export function stopIntentQuestionId(asset: AssetSymbol): string {
  return `${assetTag(asset)}_stop_intent`
}
export function targetIntentQuestionId(asset: AssetSymbol): string {
  return `${assetTag(asset)}_target_intent`
}

const ACTION_CRITERIA: Record<string, string> = {
  HOLD: 'Keep the position exactly as it is — no change to size or protection.',
  ADD: 'Increase the position size — conviction has strengthened and there is room to add risk.',
  REDUCE: 'Partially reduce the position size — take some risk or profit off the table while keeping the position open.',
  CLOSE: 'Exit the position entirely — the thesis is broken, invalidated, or the trade has run its course.',
  MODIFY_PROTECTION: 'Keep the position size unchanged, but tighten the stop-loss and/or move the take-profit.',
}

const STOP_INTENT_CRITERIA: Record<string, string> = {
  KEEP: 'Leave the stop-loss exactly where it is.',
  TIGHTEN_TO_BREAKEVEN: 'Tighten the stop-loss toward the entry price, to protect against giving back the entire position.',
}

const TARGET_INTENT_CRITERIA: Record<string, string> = {
  KEEP: 'Leave the take-profit exactly where it is.',
  MOVE_CLOSER: 'Move the take-profit closer to the current price — bank the available gain sooner.',
  MOVE_OUT: 'Move the take-profit further from the current price — give the position more room to run.',
}

const ADD_CONVICTION_LEVELS = [
  'Modest conviction — a small addition would be reasonable.',
  'Moderate conviction — a meaningful addition would be reasonable.',
  'Strong conviction — the maximum reasonable addition would be justified.',
]

const REDUCE_MAGNITUDE_LEVELS = [
  'Trim a small portion — the thesis is still intact.',
  'Take roughly half off — meaningfully de-risk while staying in the trade.',
  'Exit most of the position — the thesis is largely broken, but not entirely.',
]

function buildManagementQuestionsForAsset(asset: AssetSymbol): Record<string, JevManagementQuestionSpec> {
  return {
    [managementActionQuestionId(asset)]: {
      type: 'choice',
      instructions: `Given the current state of the open ${asset} position (its entry, current price, unrealized P&L, protection levels, holding time, and any relevant news), what should happen to it right now?`,
      criteria: ACTION_CRITERIA,
    },
    // Speculative — asked regardless of what the action answer turns out
    // to be, per the documented fan-out pattern; consumed only on the
    // ADD/REDUCE branch, never on the others.
    [addConvictionQuestionId(asset)]: {
      type: 'score',
      instructions: `If the ${asset} position were increased right now, how strong is the conviction behind adding to it?`,
      criteria: ADD_CONVICTION_LEVELS,
    },
    [reduceMagnitudeQuestionId(asset)]: {
      type: 'score',
      instructions: `If the ${asset} position were reduced right now, how much of it should come off?`,
      criteria: REDUCE_MAGNITUDE_LEVELS,
    },
    [stopIntentQuestionId(asset)]: {
      type: 'choice',
      instructions: `Should the stop-loss on the open ${asset} position be tightened right now?`,
      criteria: STOP_INTENT_CRITERIA,
    },
    [targetIntentQuestionId(asset)]: {
      type: 'choice',
      instructions: `Should the take-profit on the open ${asset} position move?`,
      criteria: TARGET_INTENT_CRITERIA,
    },
  }
}

export function buildManagementQuestions(candidates: ManagementCandidateInput[]): Record<string, JevManagementQuestionSpec> {
  const questions: Record<string, JevManagementQuestionSpec> = {}
  for (const candidate of candidates) {
    Object.assign(questions, buildManagementQuestionsForAsset(candidate.asset))
  }
  return questions
}
