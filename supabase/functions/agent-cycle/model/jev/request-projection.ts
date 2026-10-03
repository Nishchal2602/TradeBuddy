import { z } from 'zod'
import type { AssetSymbol } from '../../../../../src/shared/market-data/types.ts'
import type { JevNewsItem, JevPositionSnapshot, JevOpportunitySnapshot } from './question.ts'
import { vetoQuestionId } from './question.ts'
import type { JevRawRequest } from './provider.ts'
import {
  managementActionQuestionId,
  addConvictionQuestionId,
  reduceMagnitudeQuestionId,
  stopIntentQuestionId,
  targetIntentQuestionId,
  remainingUpsideQuestionId,
} from './management-question.ts'
import { entryQualityQuestionId, expectedMoveQuestionId } from './entry-question.ts'
import { failureRiskQuestionId, failureModeQuestionId } from './adversarial-question.ts'

// Tier 0/1 provenance (2026-10-03, plan §6B "Jev continuous-evaluation
// architecture", P0 item 2: "stable per-row Jev-request record").
//
// The problem this closes (plan §6B §5): the full Jev request (model +
// state + verbatim question text) IS already persisted today, inside
// agent_decisions.output_payload.request — but that column is explicitly
// declared NOT a stable contract (the 2026-10-03 advisory-evaluation
// migration's own header: "nothing in src/ reads it... should not be
// relied on"), is null for an entire class of rows (no-call, call-
// failed, every occupied-asset shadow row), and — the defect that
// actually matters for replay — is BATCH-WIDE, not per-asset: every row
// from a cycle carries every asset's news/position/opportunity and every
// question id the WHOLE cycle asked, not just this row's own slice.
// Per-asset replay requires projection; batch composition is itself a
// confound a later reader must not have to reconstruct by hand.
//
// This module is that projection — pure, no I/O, deterministic given its
// inputs. It is Tier 0/1 CAPTURE only: it does not compute a case_id or
// evaluation_id (plan §6B P0 item 3, not yet built — see that section's
// own reasoning for why model+prompt must NOT be folded into this
// record's own identity, only into a case's separate evaluation_id
// later) and it does not touch any trading decision — purely additive,
// observational.
//
// Scope is deliberately the REQUEST side only, not the response/output
// side: every Jev OUTPUT this project cares about (veto noul, entry
// quality + distribution, failure risk/mode + distribution, management
// action + distribution, etc.) already has its own stable, typed,
// individually-versioned column from the 2026-10-03 advisory-evaluation
// migration. Re-embedding those into this record too would duplicate
// data that already has a single source of truth, risking exactly the
// kind of two-copies-silently-diverge drift this whole P0 phase exists
// to eliminate (prompt-hash.ts's own header tells the same story about
// *_QUESTION_VERSION strings).
//
// Why the deep Jev snapshot fields (news/position/opportunity/questions)
// are NOT re-declared as a second, parallel Zod schema here: each one
// already has exactly one precise TypeScript source of truth
// (question.ts's JevNewsItem/JevPositionSnapshot/JevOpportunitySnapshot;
// client.ts's AnyJevQuestionSpec, exported for this exact reuse).
// Re-typing them in Zod would be a second hand-maintained copy of
// something that already has one, and copies drift (see this file's own
// paragraph above). What a future reader of this persisted JSON actually
// needs a RUNTIME guarantee about is the ENVELOPE — are schemaVersion,
// asset, modelRequested/modelResolved, and the top-level shape what they
// claim to be — so that is the ONLY thing JevRequestProjectionEnvelopeSchema
// validates. The leaf values pass through verbatim from already-typed,
// same-compile-unit sources; TypeScript, not a second runtime schema, is
// what keeps those honest at write time.

export const JEV_REQUEST_PROJECTION_SCHEMA_VERSION = 'v1' as const

const JevRequestProjectionEnvelopeSchema = z.object({
  schemaVersion: z.literal(JEV_REQUEST_PROJECTION_SCHEMA_VERSION),
  asset: z.string().min(1),
  modelRequested: z.string().min(1),
  modelResolved: z.string().min(1).nullable(),
  evaluatedAt: z.string().min(1),
  news: z.array(z.unknown()),
  position: z.unknown().nullable(),
  opportunity: z.unknown().nullable(),
  portfolio: z.object({
    navUsd: z.number(),
    availableCashUsd: z.number(),
    totalExposurePct: z.number(),
  }).nullable(),
  questions: z.record(z.string(), z.unknown()),
})

export interface JevRequestProjection {
  schemaVersion: typeof JEV_REQUEST_PROJECTION_SCHEMA_VERSION
  asset: AssetSymbol
  // The requested model id (JEV_MODEL_ID at call time) and the model
  // actually resolved/echoed back by the API — kept distinct exactly
  // like every other requested-vs-resolved pair in this codebase (e.g.
  // the alias-vs-pinned-version distinction JEV_MODEL_ID's own comment
  // describes). null only when no call happened at all — unreachable in
  // practice, since projectJevRequestForAsset is only ever called after
  // a genuine successful call (see index.ts's own call site guard).
  modelRequested: string
  modelResolved: string | null
  evaluatedAt: string
  news: JevNewsItem[]
  position: JevPositionSnapshot | null
  opportunity: JevOpportunitySnapshot | null
  portfolio: { navUsd: number; availableCashUsd: number; totalExposurePct: number } | null
  // Every question id this SPECIFIC asset was actually asked this cycle
  // (a subset of rawRequest.questions, filtered via the same id-builder
  // functions each module already exports — not a string-prefix/suffix
  // pattern match, which would be fragile against the three different id
  // conventions these modules use: veto_btc vs btc_action vs
  // btc_entry_quality). Carries the EXACT, already-interpolated
  // instructions/criteria text actually sent — complementary to, not
  // duplicating, prompt-hash.ts's module-level fingerprints (those catch
  // TEMPLATE wording drift across representative fixtures; this captures
  // the literal per-row rendered text for one real call).
  questions: Record<string, unknown>
}

// All ten question-id builders this project has, across all four
// prompt modules — deliberately an explicit list, not a string-pattern
// match, so adding an eleventh question type is a one-line addition here
// rather than a silent gap.
function questionIdsFor(asset: AssetSymbol): string[] {
  return [
    vetoQuestionId(asset),
    managementActionQuestionId(asset),
    addConvictionQuestionId(asset),
    reduceMagnitudeQuestionId(asset),
    stopIntentQuestionId(asset),
    targetIntentQuestionId(asset),
    remainingUpsideQuestionId(asset),
    entryQualityQuestionId(asset),
    expectedMoveQuestionId(asset),
    failureRiskQuestionId(asset),
    failureModeQuestionId(asset),
  ]
}

// Throws on a malformed envelope — deliberately strict, matching this
// project's "a genuine shape failure, never silently coerced or
// defaulted" discipline (schema.ts's own expectNoul/expectChoice/
// expectScore comment states the identical principle for Jev's own API
// responses). The caller (index.ts) wraps this in a try/catch and treats
// a thrown error as "no projection for this row" — observational
// telemetry failing must never block the real trading decision it
// accompanies, same non-fatal discipline as the market_bars upsert and
// the occupied-asset shadow row.
export function projectJevRequestForAsset(
  rawRequest: JevRawRequest,
  modelResolved: string | null,
  asset: AssetSymbol,
): JevRequestProjection {
  const assetState = rawRequest.state.assets[asset]
  const askedIds = questionIdsFor(asset).filter((id) => id in rawRequest.questions)
  const questions = Object.fromEntries(askedIds.map((id) => [id, rawRequest.questions[id]]))

  const projection: JevRequestProjection = {
    schemaVersion: JEV_REQUEST_PROJECTION_SCHEMA_VERSION,
    asset,
    modelRequested: rawRequest.model,
    modelResolved,
    evaluatedAt: rawRequest.state.evaluatedAt,
    news: assetState?.news ?? [],
    position: assetState?.position ?? null,
    opportunity: assetState?.opportunity ?? null,
    portfolio: rawRequest.state.navUsd !== undefined
      ? {
        navUsd: rawRequest.state.navUsd,
        availableCashUsd: rawRequest.state.availableCashUsd ?? 0,
        totalExposurePct: rawRequest.state.totalExposurePct ?? 0,
      }
      : null,
    questions,
  }

  JevRequestProjectionEnvelopeSchema.parse(projection)
  return projection
}
