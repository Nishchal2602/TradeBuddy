import type { AssetSymbol } from '../../../../../src/shared/market-data/types.ts'
import type { Direction } from '../../../../../src/shared/positions/types.ts'
import type { JevNewsItem, JevPositionSnapshot, JevState } from './question.ts'
import type { VetoCandidateInput } from '../payload.ts'
import { buildJevState } from './question.ts'
import { computeCostR, computePositionPnlR, computePriceR } from '../../strategy/aggressive/protection.ts'

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
// under whichever version actually produced it. Bumped 2026-09-23
// (v1 -> v2) for the profit-recycling reframe: the action question's
// wording, the TIGHTEN_TOWARD_ENTRY rename, the protectionActionable gate,
// and the new remaining_upside question all change what a row means.
export const MANAGEMENT_QUESTION_VERSION = `jev-management-v2/atr${TP_STEP_ATR_MULTIPLE.toFixed(1)}`

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
//
// Field-by-field send/never-send list (migration plan §8, extended by the
// profit-recycling plan §4.1):
//
// SENT: direction, entryPrice, currentPrice, quantity, notionalUsd,
// unrealizedPnlPct/Usd, estimatedRoundTripCostPct, heldHours,
// stopLossPrice/takeProfitPrice, distanceToStopPct/TakeProfitPct, plus the
// SAME news evidence the veto question already sends for that asset.
// Aggressive-only (candidate.aggressive present): priceR, positionPnlR,
// sampledMfeR/MaeR, givebackR/Ratio, profitState, costR,
// minutesSinceEntry, atrPct, and the intraday features (ret15m/30m/60m,
// realizedVol5m, volumeTrendRatio, sampledDayHigh/LowPct).
//
// NEVER SENT: API keys, user/portfolio/run/position ids, cash, NAV, or
// any other-asset's exposure (a management question is scoped to ONE
// position; cross-asset portfolio context is deliberately NOT given to
// Jev — the deterministic gate is the sole owner of cross-asset risk,
// exactly as it already is for OPEN's cross-asset caps).

// Aggressive-only extension to a management candidate — undefined for
// every Balanced candidate, which keeps buildPositionSnapshot's Balanced
// output BYTE-IDENTICAL to what it produced before this revision (a
// dedicated regression test asserts this). See profile-recycling plan
// §4.1: this is what actually fixes the diagnosis finding that Jev's
// management context was silently missing every one of these fields —
// they were declared on JevPositionSnapshot with a comment claiming an
// Aggressive producer existed, but none did until now.
export interface AggressiveManagementContext {
  // The immutable ruler triple (positions.initial_entry_price/
  // initial_stop_loss_price/initial_risk_usd) — never redefined by a
  // later ADD/REDUCE.
  initialEntryPrice: number
  initialStopLossPrice: number
  initialRiskUsd: number
  // Cumulative realized P&L from REDUCE only (positions.
  // partial_realized_pnl_usd) — what keeps positionPnlR continuous across
  // a partial exit.
  partialRealizedPnlUsd: number
  // Monitor-sampled high-water state (positions.sampled_mfe_r/mae_r) —
  // null when this position has never been sampled yet (freshly eligible
  // this very cycle, before the monitor's first tick).
  sampledMfeR: number | null
  sampledMaeR: number | null
  minutesSinceEntry: number
  // Deterministic broker round-trip cost (fee+slippage, both sides) for
  // the CURRENT quantity — the numerator computeCostR uses against the
  // immutable initialRiskUsd denominator.
  currentRoundTripCostUsd: number
  // Deterministic short-horizon features (strategy/aggressive/
  // features.ts), reused from the entry path — never recomputed with a
  // different formula.
  ret15mPct: number
  ret30mPct: number
  ret60mPct: number
  realizedVol5m: number
  volumeTrendRatio: number
  sampledDayHighPct: number
  sampledDayLowPct: number
}

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
  // Shared by both profiles — used to decide whether a legal stop tighten
  // exists at all (protectionActionable below), independent of whether
  // this candidate also carries aggressive-only profit state.
  minStopLossPct: number
  // Undefined for Balanced — see AggressiveManagementContext's own
  // comment.
  aggressive?: AggressiveManagementContext
}

function profitStateFor(sampledMfeR: number | null, givebackRatio: number | null): JevPositionSnapshot['profitState'] {
  if (sampledMfeR === null || sampledMfeR < 1.0) return 'UNPROVEN'
  if (givebackRatio === null || givebackRatio < 0.33) return 'PROVEN'
  if (givebackRatio < 0.66) return 'DETERIORATING'
  return 'GIVING_BACK'
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

  const base: JevPositionSnapshot = {
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

  const agg = candidate.aggressive
  if (!agg) return base // Balanced — BYTE-IDENTICAL to the pre-2026-09-23 shape, no extension keys at all

  const priceR = computePriceR(currentPrice, agg.initialEntryPrice, agg.initialStopLossPrice, direction)
  const positionPnlR = computePositionPnlR(unrealizedPnlUsd, agg.partialRealizedPnlUsd, agg.initialRiskUsd)
  const costR = computeCostR(agg.currentRoundTripCostUsd, agg.initialRiskUsd)
  const givebackR = agg.sampledMfeR === null ? undefined : Math.max(0, agg.sampledMfeR - positionPnlR)
  const givebackRatio = givebackR === undefined || agg.sampledMfeR === null || agg.sampledMfeR <= 0 ? undefined : givebackR / agg.sampledMfeR

  return {
    ...base,
    priceR,
    positionPnlR,
    sampledMfeR: agg.sampledMfeR ?? undefined,
    sampledMaeR: agg.sampledMaeR ?? undefined,
    givebackR,
    givebackRatio,
    profitState: profitStateFor(agg.sampledMfeR, givebackRatio ?? null),
    costR,
    minutesSinceEntry: agg.minutesSinceEntry,
    atrPct: candidate.atrPct,
    ret15mPct: agg.ret15mPct,
    ret30mPct: agg.ret30mPct,
    ret60mPct: agg.ret60mPct,
    realizedVol5m: agg.realizedVol5m,
    volumeTrendRatio: agg.volumeTrendRatio,
    sampledDayHighPct: agg.sampledDayHighPct,
    sampledDayLowPct: agg.sampledDayLowPct,
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
// Aggressive-only (2026-09-23) — see buildRemainingUpsideQuestion below.
export function remainingUpsideQuestionId(asset: AssetSymbol): string {
  return `${assetTag(asset)}_remaining_upside`
}

const ACTION_CRITERIA: Record<string, string> = {
  HOLD: 'Keep the position exactly as it is — no change to size or protection.',
  ADD: 'Increase the position size — conviction has strengthened and there is room to add risk.',
  REDUCE: 'Partially reduce the position size — take some risk or profit off the table while keeping the position open.',
  CLOSE: 'Exit the position entirely — the thesis is broken, invalidated, or the trade has run its course.',
  MODIFY_PROTECTION: 'Keep the position size unchanged, but tighten the stop-loss and/or move the take-profit.',
}

// Renamed from TIGHTEN_TO_BREAKEVEN 2026-09-23 — see provider.ts's own
// comment on the StopIntent type for why, and worded honestly: this lands
// slightly INSIDE entry, not at true breakeven. Only ever offered when
// protectionActionable is true (below) — see isProtectionActionable.
const STOP_INTENT_CRITERIA: Record<string, string> = {
  KEEP: 'Leave the stop-loss exactly where it is.',
  TIGHTEN_TOWARD_ENTRY: 'Tighten the stop-loss toward (but not past) the entry price, to reduce how much could still be given back.',
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

// Reuses entry-question.ts's own EXPECTED_MOVE_PCT_BY_SCORE_LEVEL table —
// deliberately the SAME levels/mapping the entry path already uses, not a
// second independent scale, so expected_move_pct means the same thing on
// an entry row and a management row.
const REMAINING_UPSIDE_LEVELS = [
  'Negligible — likely to be consumed by fees and slippage alone.',
  'Modest — a small further move, comparable in size to the round-trip cost.',
  'Meaningful — clearly larger than the round-trip cost, worth continuing to hold for.',
  'Substantial — a large further move relative to typical short-horizon volatility for this asset.',
]

// A legal tighten exists when the candidate stop (TIGHTEN_TOWARD_ENTRY's
// own formula) is BOTH strictly tighter than the current stop AND
// strictly on the safe side of the current price — the exact two checks
// src/shared/risk/gate.ts's evaluateModifyProtection independently
// enforces. Mirrors that function's own logic rather than re-deriving a
// different rule, specifically so a "no" here always agrees with what the
// gate would have said. This is what fixes the diagnosis finding: an
// underwater position (candidate stop lands ABOVE current price for a
// long) previously still offered MODIFY_PROTECTION/TIGHTEN_TO_BREAKEVEN
// as Jev's only coherent answer whenever it wanted to protect the
// position, then rejected it — invisibly, since the gate was never
// reached (apply-management.ts's own KEEP/KEEP no-op normalization fired
// first).
export function isProtectionActionable(candidate: ManagementCandidateInput): boolean {
  const { direction, entryPrice, currentPrice, stopLossPrice, minStopLossPct } = candidate
  const candidateStop = direction === 'long' ? entryPrice * (1 - minStopLossPct) : entryPrice * (1 + minStopLossPct)
  const tightens = direction === 'long' ? candidateStop > stopLossPrice : candidateStop < stopLossPrice
  const wouldStopOutNow = direction === 'long' ? candidateStop >= currentPrice : candidateStop <= currentPrice
  return tightens && !wouldStopOutNow
}

// The reframed action question (profile-recycling plan §4.2) — marginal
// return versus profit already accumulated, not "are you bullish?" (that
// phrasing anchors reasoning to the broader trend, which is exactly what
// this strategy's short horizon must NOT do). Balanced's wording is
// UNCHANGED — this only branches when candidate.aggressive is present.
function buildActionInstructions(candidate: ManagementCandidateInput): string {
  const { asset } = candidate
  const agg = candidate.aggressive
  if (!agg) {
    return `Given the current state of the open ${asset} position (its entry, current price, unrealized P&L, protection levels, holding time, and any relevant news), what should happen to it right now?`
  }
  const positionPnlR = computePositionPnlR(
    candidate.direction === 'long'
      ? (candidate.currentPrice - candidate.entryPrice) * candidate.quantity
      : (candidate.entryPrice - candidate.currentPrice) * candidate.quantity,
    agg.partialRealizedPnlUsd,
    agg.initialRiskUsd,
  )
  const priceR = computePriceR(candidate.currentPrice, agg.initialEntryPrice, agg.initialStopLossPrice, candidate.direction)
  const costR = computeCostR(agg.currentRoundTripCostUsd, agg.initialRiskUsd)
  const sampledMfeR = agg.sampledMfeR
  const givebackRatio = sampledMfeR === null || sampledMfeR <= 0 ? null : Math.max(0, sampledMfeR - positionPnlR) / sampledMfeR

  const mfeText = sampledMfeR === null ? 'not yet been sampled' : `reached a best point of ${sampledMfeR.toFixed(2)}R`
  const givebackText = givebackRatio === null ? '' : `, having given back ${(givebackRatio * 100).toFixed(0)}% of its best gain`

  return `This ${asset} position has ${mfeText} and is now at ${positionPnlR.toFixed(2)}R${givebackText}. `
    + `Price itself is ${priceR.toFixed(2)}R from the original entry. A full round trip costs ${costR.toFixed(2)}R. `
    + `Considering the short-horizon momentum, the profit already accumulated, and how much of it is already gone — `
    + `is continuing to hold the full position better than realizing part or all of it now?`
}

function buildManagementQuestionsForAsset(candidate: ManagementCandidateInput): Record<string, JevManagementQuestionSpec> {
  const { asset } = candidate
  const protectionActionable = isProtectionActionable(candidate)

  // omit MODIFY_PROTECTION entirely when no legal tighten exists — the
  // action space must never offer a choice the gate is guaranteed to
  // reject, or Jev's only coherent way to express "protect this" becomes
  // a silent no-op (profile-recycling plan §4.3).
  const actionCriteria = protectionActionable
    ? ACTION_CRITERIA
    : Object.fromEntries(Object.entries(ACTION_CRITERIA).filter(([action]) => action !== 'MODIFY_PROTECTION'))

  const questions: Record<string, JevManagementQuestionSpec> = {
    [managementActionQuestionId(asset)]: {
      type: 'choice',
      instructions: buildActionInstructions(candidate),
      criteria: actionCriteria,
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

  // Aggressive-only, non-action question (profile-recycling plan §4.4) —
  // reuses the existing five-action schema rather than adding a parallel
  // PROTECT_PROFIT/HOLD_FOR_CONTINUATION/TAKE_PARTIAL_PROFIT/EXIT action
  // space (which would be near-isomorphic to the one above with no
  // mechanism to reconcile disagreement). This instead populates
  // expected_move_pct/move_to_cost_ratio on a MANAGEMENT row — previously
  // null on every Aggressive row, since Pass 3 only ever set them on the
  // entry branch — giving "did the model see the deterioration?" a
  // directly measurable answer.
  if (candidate.aggressive) {
    questions[remainingUpsideQuestionId(asset)] = {
      type: 'score',
      instructions: `If the ${asset} position were left open right now, how large a further favorable move do you expect over the next 15-60 minutes?`,
      criteria: REMAINING_UPSIDE_LEVELS,
    }
  }

  return questions
}

export function buildManagementQuestions(candidates: ManagementCandidateInput[]): Record<string, JevManagementQuestionSpec> {
  const questions: Record<string, JevManagementQuestionSpec> = {}
  for (const candidate of candidates) {
    Object.assign(questions, buildManagementQuestionsForAsset(candidate))
  }
  return questions
}
