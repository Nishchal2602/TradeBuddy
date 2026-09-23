import type { AssetSymbol } from '../../../../../src/shared/market-data/types.ts'
import type { VetoCandidateInput } from '../payload.ts'

// Gemini → Jev migration (2026-09-22, full removal — Jev is the sole
// model provider, no fallback). This module owns everything about WHAT
// gets asked, as opposed to client.ts (HOW it's transported) and
// provider.ts (the seam agent-cycle/index.ts actually calls).

// ---------------------------------------------------------------------------
// Model identifier
// ---------------------------------------------------------------------------
//
// PINNED — Phase 0 of the migration plan (GET /v1/models, then reading the
// resolved `model` field back from a real /v1/systemone call, since the
// models list itself only names floating aliases, not concrete versions)
// ran live on 2026-09-22: `jev-latest` resolved to this exact version.
// TypeSafe's own docs are explicit that production code should pin a
// concrete version rather than ride an alias ("if you have tuned
// confidence thresholds against a specific version, pin that version's ID
// instead of the alias and move to the new one on your own schedule") —
// confirmed via the typesafe-ai skill before making this change. A
// version bump here is a deliberate, reviewed action, never automatic:
// re-run the Phase 2 Stage A adversarial-pair live check
// (jev.live-check.ts) against any new version before repointing this at
// it, exactly as if evaluating a brand-new provider.
export const JEV_MODEL_ID = 'jev-1.13.0'

// ---------------------------------------------------------------------------
// Threshold — PROVISIONAL, not validated
// ---------------------------------------------------------------------------
//
// No threshold exists anywhere in the pre-migration codebase — Gemini's
// veto was a plain boolean. This is therefore a genuinely new decision
// surface, not a ported value, and it ships deliberately unvalidated
// (explicit product decision, 2026-09-22): gating the first deployment on
// a labeled-evaluation threshold study was rejected in favor of getting
// Jev under real observation sooner. The live decision corpus is
// currently too small (single-digit rows) for such a study to mean much
// anyway.
//
// What makes this safe to ship provisional is persistence, not
// pre-validation: every model-assisted decision persists the RAW `noul`
// value (provider.ts's VetoOutcome.noul, carried into
// agent_decisions.output_payload by index.ts) — so the eventual threshold
// review is a query over accumulated real observations, not a replay of
// every decision through the API. See the migration plan's "Stage B."
//
// 0.70 is a directional starting guess, not a computed value: Jev's own
// docs state noul=0.5 means genuine ambiguity ("the model gives yes and
// no similar probability"), and this design intends a veto to be a rare
// exception for a specific named event, not a general risk opinion — a
// mid-point cut would turn every ambiguous news day into a coin-flip
// veto. NEVER describe this value as "validated" in code, commits, or
// progress-tracker.md until Stage B has actually run.
export const JEV_VETO_THRESHOLD = 0.70

// Bumped whenever the question wording OR the threshold changes —
// persisted into agent_decisions.prompt_version (index.ts) so a
// historical row stays interpretable under whichever question/threshold
// pair actually produced it. Format mirrors the threshold in the version
// string itself for quick human legibility in a decisions list.
export const JEV_QUESTION_VERSION = `jev-veto-v1/t${JEV_VETO_THRESHOLD.toFixed(2)}`

// ---------------------------------------------------------------------------
// State — deliberately narrower than what Gemini received
// ---------------------------------------------------------------------------
//
// VetoCandidateInput's own `regime`/`stopLossPct`/`takeProfitPct` fields
// are NOT sent — those invite exactly the trend second-guessing and
// "would you have sized it differently" reasoning the design forbids
// Jev from doing (it structurally cannot decide direction, sizing,
// stop-loss, or take-profit if none of that is in its state).
// `news[].id` (an internal news_items UUID) is dropped too — zero
// decision value to an external question-answering model.
//
// The API's own request shape is ONE shared `state` plus a map of
// per-question `questions` — not one state per question — so both
// assets' evidence lives in one state object, keyed by asset, and each
// question's own instructions scope it to a single asset by name. This
// relies on TypeSafe's documented "questions are evaluated in parallel
// and in isolation" property for cross-asset isolation, not on
// structurally separate requests (which would cost 2 HTTP calls instead
// of 1 — see provider.ts).

export interface JevNewsItem {
  source: string
  headline: string
  summary: string | null
  publishedAt: string
  ageMinutes: number
}

// Phase 2 (2026-09-22) — an OPEN position's own state, present only for
// an asset the management question set (model/jev/management-question.ts)
// is asking about. Never balances/user ids/internal position ids — only
// what a management decision could plausibly need. See management-
// question.ts's own module comment for the full field-by-field
// send/never-send rationale (§8 of the migration plan).
export interface JevPositionSnapshot {
  direction: 'long' | 'short'
  entryPrice: number
  currentPrice: number
  quantity: number
  notionalUsd: number
  unrealizedPnlPct: number
  unrealizedPnlUsd: number
  estimatedRoundTripCostPct: number
  heldHours: number
  stopLossPrice: number
  takeProfitPrice: number
  distanceToStopPct: number
  distanceToTakeProfitPct: number
}

export interface JevState {
  evaluatedAt: string
  // Portfolio-level fields are OPTIONAL and absent entirely for a
  // veto-only cycle (no open positions at all) — kept exactly as narrow
  // as the pre-Phase-2 state was whenever there is nothing to manage.
  navUsd?: number
  availableCashUsd?: number
  totalExposurePct?: number
  assets: Record<string, { news: JevNewsItem[]; position?: JevPositionSnapshot }>
}

export function buildJevState(candidates: VetoCandidateInput[], nowIso: string): JevState {
  const assets: Record<string, { news: JevNewsItem[] }> = {}
  for (const candidate of candidates) {
    assets[candidate.asset] = {
      news: candidate.news.map((n) => ({
        source: n.source,
        headline: n.headline,
        summary: n.summary,
        publishedAt: n.publishedAt,
        ageMinutes: n.ageMinutes,
      })),
    }
  }
  return { evaluatedAt: nowIso, assets }
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export interface JevQuestionSpec {
  type: 'noul'
  instructions: string
  criteria: { true: string; false: string }
}

// Deterministic, not asset-derived-at-parse-time — provider.ts looks the
// answer back up by this exact id, so the same mapping function is used
// on both the build side and the read side.
export function vetoQuestionId(asset: AssetSymbol): string {
  return `veto_${asset.toLowerCase()}`
}

const CRITERIA: JevQuestionSpec['criteria'] = {
  true: 'A specific, named, material event with credible evidence, directly relevant to the asset or its ability to trade — hack or exploit, regulatory action or ban, exchange failure, critical protocol bug.',
  false: 'Price commentary, generic market commentary, analyst opinion, ordinary volatility, technical weakness, prediction or speculation, or restatement of the price move itself.',
}

function buildJevQuestion(asset: AssetSymbol): JevQuestionSpec {
  return {
    type: 'noul',
    instructions: `Does the supplied news evidence contain a material, known, exogenous event specific to ${asset} that should prevent opening a new long position right now?`,
    criteria: CRITERIA,
  }
}

export function buildJevQuestions(candidates: VetoCandidateInput[]): Record<string, JevQuestionSpec> {
  const questions: Record<string, JevQuestionSpec> = {}
  for (const candidate of candidates) {
    questions[vetoQuestionId(candidate.asset)] = buildJevQuestion(candidate.asset)
  }
  return questions
}
