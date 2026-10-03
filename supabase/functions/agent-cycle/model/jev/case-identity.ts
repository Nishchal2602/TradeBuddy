import type { AssetSymbol } from '../../../../../src/shared/market-data/types.ts'
import { hashPromptContent } from './prompt-hash.ts'
import type { JevRequestProjection } from './request-projection.ts'
import { vetoQuestionId, jevQuestionPromptFingerprint } from './question.ts'
import {
  managementActionQuestionId,
  addConvictionQuestionId,
  reduceMagnitudeQuestionId,
  stopIntentQuestionId,
  targetIntentQuestionId,
  remainingUpsideQuestionId,
  managementQuestionPromptFingerprint,
} from './management-question.ts'
import { entryQualityQuestionId, expectedMoveQuestionId, entryQuestionPromptFingerprint } from './entry-question.ts'
import { failureRiskQuestionId, failureModeQuestionId, adversarialQuestionPromptFingerprint } from './adversarial-question.ts'

// Tier 0/1 provenance (2026-10-03, plan §6B "Jev continuous-evaluation
// architecture", P0 item 3 — "Separate case_id from evaluation_id",
// following P0 items 1 (prompt-artifact hashing) and 2 (the stable
// per-row request projection these two identifiers are both computed
// from).
//
// **A case is the input. An evaluation is one model's answer to it.**
// This is the review correction the plan file itself documents: an
// earlier draft folded model+prompt into the CASE's own identity, which
// would have given champion and challenger DIFFERENT case ids for
// IDENTICAL input — destroying the pairing §6B §9's whole comparison
// design depends on (a paired test needs both arms scored against the
// same case, not two unrelated ones that happen to look similar).
//
//   case_id        = hash(input_state_projection)
//   evaluation_id  = hash(case_id, model_id, prompt_hashes, inference_config)
//
//   CASE-123  (the market situation — one row)
//      |- evaluation: champion  v1
//      `- evaluation: challenger v2
//
// case_id therefore depends ONLY on the market situation Jev was shown —
// asset, evaluatedAt, news, position, opportunity, portfolio exposure —
// and explicitly EXCLUDES which model answered and what the rendered
// question text said, even though both of those also live on
// JevRequestProjection. Two prompt versions evaluating the identical
// market moment must produce the SAME case_id; only evaluation_id may
// differ between them.

export interface JevCaseInput {
  asset: AssetSymbol
  evaluatedAt: string
  news: JevRequestProjection['news']
  position: JevRequestProjection['position']
  opportunity: JevRequestProjection['opportunity']
  portfolio: JevRequestProjection['portfolio']
}

// The market-situation slice of a JevRequestProjection — everything
// EXCEPT schemaVersion/modelRequested/modelResolved/questions, which are
// evaluation-specific, not case-specific. A pure projection of a
// projection, deliberately: this derives from request-projection.ts's
// own record rather than re-reading the raw Jev request a second way,
// so the two can never silently disagree about what "the input" means.
export function caseInputFromRequestProjection(projection: JevRequestProjection): JevCaseInput {
  return {
    asset: projection.asset,
    evaluatedAt: projection.evaluatedAt,
    news: projection.news,
    position: projection.position,
    opportunity: projection.opportunity,
    portfolio: projection.portfolio,
  }
}

export async function computeCaseId(caseInput: JevCaseInput): Promise<string> {
  return hashPromptContent([JSON.stringify(caseInput)])
}

// Every question family this project has, each paired with (a) the
// explicit list of ids that family could ask for one asset — reused
// verbatim from request-projection.ts's own id-builder calls, never a
// string-pattern match — and (b) its module-level prompt fingerprint
// (P0 item 1). A fixed iteration order (not object-key order, which
// would depend on insertion sequence) so promptHashes is byte-stable
// for the identical set of families across repeated calls.
const QUESTION_FAMILIES: ReadonlyArray<{
  name: string
  idsFor: (asset: AssetSymbol) => string[]
  fingerprint: () => Promise<string>
}> = [
  { name: 'veto', idsFor: (asset) => [vetoQuestionId(asset)], fingerprint: jevQuestionPromptFingerprint },
  {
    name: 'management',
    idsFor: (asset) => [
      managementActionQuestionId(asset),
      addConvictionQuestionId(asset),
      reduceMagnitudeQuestionId(asset),
      stopIntentQuestionId(asset),
      targetIntentQuestionId(asset),
      remainingUpsideQuestionId(asset),
    ],
    fingerprint: managementQuestionPromptFingerprint,
  },
  { name: 'entry', idsFor: (asset) => [entryQualityQuestionId(asset), expectedMoveQuestionId(asset)], fingerprint: entryQuestionPromptFingerprint },
  { name: 'adversarial', idsFor: (asset) => [failureRiskQuestionId(asset), failureModeQuestionId(asset)], fingerprint: adversarialQuestionPromptFingerprint },
]

// Which question families this SPECIFIC row's projection actually asked
// — determined by id membership in projection.questions, not by
// threading a separate per-branch "which family ran" flag through
// index.ts (management has no independent prompt-version column at all
// today; deriving from the projection itself needs none and can't drift
// from what was actually asked). One module-level fingerprint per family
// present, never per-row re-derived from the literal interpolated text:
// evaluation_id must treat two BTC/ETH rows asked under the IDENTICAL
// prompt version as sharing the same prompt_hash component, varying only
// in case_id.
async function promptHashesForProjection(projection: JevRequestProjection): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  for (const family of QUESTION_FAMILIES) {
    const ids = family.idsFor(projection.asset)
    if (ids.some((id) => id in projection.questions)) {
      hashes[family.name] = await family.fingerprint()
    }
  }
  return hashes
}

// inferenceConfig defaults to {} — this system has no caller-supplied
// sampling/temperature/determinism parameter today (client.ts's request
// body is exactly { model, state, questions }, nothing else). The
// parameter exists so a future request-shaping option slots in without
// changing this function's signature, per the plan's own instruction
// ("anything that can affect model output must be in there") — it is a
// deliberate placeholder, not a sign something is already missing.
export async function computeEvaluationId(
  caseId: string,
  projection: JevRequestProjection,
  inferenceConfig: Record<string, unknown> = {},
): Promise<string> {
  const promptHashes = await promptHashesForProjection(projection)
  const modelId = projection.modelResolved ?? projection.modelRequested
  return hashPromptContent([caseId, modelId, JSON.stringify(promptHashes), JSON.stringify(inferenceConfig)])
}
