import { callJev, JevCallError } from './client.ts'
import type { JevCallOptions } from './client.ts'
import { expectChoice, expectNoul, expectScore } from './schema.ts'
import type { JevAnswer } from './schema.ts'
import { buildJevQuestions, buildJevState, JEV_MODEL_ID, JEV_QUESTION_VERSION, JEV_VETO_THRESHOLD, vetoQuestionId } from './question.ts'
import {
  ADD_MAGNITUDE_BY_SCORE_LEVEL,
  addConvictionQuestionId,
  buildManagementQuestions,
  buildPortfolioState,
  magnitudeFromScore,
  managementActionQuestionId,
  MANAGEMENT_QUESTION_VERSION,
  REDUCE_MAGNITUDE_BY_SCORE_LEVEL,
  reduceMagnitudeQuestionId,
  stopIntentQuestionId,
  targetIntentQuestionId,
} from './management-question.ts'
import type { ManagementCandidateInput } from './management-question.ts'
import type { AssetSymbol } from '../../../../../src/shared/market-data/types.ts'
import type { VetoCandidateInput } from '../payload.ts'

// The single seam agent-cycle/index.ts calls — occupies exactly the same
// role the old callModel(payload) did, with one structural difference
// that matters: this function's return type physically cannot carry a
// probability out to its caller in a way that could influence anything
// but the veto boolean. `noul` travels on VetoOutcome for persistence/
// audit only; index.ts never reads it to make a decision, only to store
// it (see the migration plan §8's "containment" requirement).
//
// No provider fallback exists. Gemini has been removed entirely
// (2026-09-22, explicit product decision) — a Jev failure of any kind
// propagates as JevCallError and the caller fails every affected
// candidate closed to HOLD. There is no second model to try.

export { JevCallError, JEV_QUESTION_VERSION, JEV_VETO_THRESHOLD, MANAGEMENT_QUESTION_VERSION }

export interface VetoOutcome {
  asset: AssetSymbol
  veto: boolean
  // The raw calibrated probability Jev returned for this candidate —
  // persisted verbatim by index.ts so the provisional threshold (§8 of
  // the migration plan) can be revisited later as a query over real
  // observations, without replaying any decision through the API.
  noul: number
}

export interface VetoRequestResult {
  outcomes: VetoOutcome[]
  modelVersion: string
  // Exact request/response, for agent_decisions.output_payload
  // (invariant 8 — replayability). Shape is free; no UI reads this
  // column (verified across src/ during planning).
  rawRequest: unknown
  rawResponse: unknown
}

export async function requestVetoDecisions(
  candidates: VetoCandidateInput[],
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  options: JevCallOptions = {},
): Promise<VetoRequestResult> {
  if (!apiKey) {
    throw new JevCallError('requestVetoDecisions: no TYPESAFE_API_KEY configured')
  }

  const nowIso = new Date().toISOString()
  const state = buildJevState(candidates, nowIso)
  const questions = buildJevQuestions(candidates)

  const result = await callJev(JEV_MODEL_ID, state, questions, apiKey, fetchImpl, options)

  const outcomes: VetoOutcome[] = candidates.map((candidate) => {
    // Safe by construction, not by luck: callJev's parseJevResponse
    // already asserted exact cardinality — one answer per question id —
    // and every question id here was built by the same vetoQuestionId()
    // function from these exact candidates.
    const answer = result.answers.find((a) => a.questionId === vetoQuestionId(candidate.asset))!
    // expectNoul throws JevOutputShapeError if the API ever returned a
    // non-noul answer for a veto question (a genuine, if rare, shape
    // failure) — Phase 2 (2026-09-22) fix: the pre-Phase-2 code read
    // `.noul` unconditionally, which would have silently read `undefined`
    // for a wrong-typed answer and produced `undefined >= threshold ===
    // false` — a silent, incorrect ALLOW. This now propagates as a loud,
    // uncaught error instead (same as any other shape failure — caught by
    // the caller's existing try/catch and failed closed to HOLD).
    const noul = expectNoul(answer)
    return { asset: candidate.asset, veto: noul >= JEV_VETO_THRESHOLD, noul }
  })

  return {
    outcomes,
    modelVersion: result.modelVersion,
    rawRequest: { model: JEV_MODEL_ID, state, questions },
    rawResponse: result.rawResponse,
  }
}

// ---------------------------------------------------------------------------
// Phase 2 (2026-09-22) — portfolio management. requestVetoDecisions above
// is UNCHANGED and still fully covers a veto-only cycle (kept, not
// deleted — still separately tested); this function is the new seam
// index.ts calls whenever there is at least one open position to manage,
// covering both the veto (FLAT candidates) and management (OPEN
// positions) questions in ONE shared request — "one request per cycle"
// stays true even when a cycle has both kinds of asset at once.
// ---------------------------------------------------------------------------

const VALID_MANAGEMENT_ACTIONS = ['HOLD', 'ADD', 'REDUCE', 'CLOSE', 'MODIFY_PROTECTION'] as const
export type ManagementAction = (typeof VALID_MANAGEMENT_ACTIONS)[number]

const VALID_STOP_INTENTS = ['KEEP', 'TIGHTEN_TO_BREAKEVEN'] as const
export type StopIntent = (typeof VALID_STOP_INTENTS)[number]

const VALID_TARGET_INTENTS = ['KEEP', 'MOVE_CLOSER', 'MOVE_OUT'] as const
export type TargetIntent = (typeof VALID_TARGET_INTENTS)[number]

// Jev's answer is untyped prose-adjacent JSON at the wire level (a
// string), even though the question's own `criteria` enumerated exactly
// these values — a genuinely different value here means the API returned
// something outside what was asked, a real shape failure, not a case to
// silently coerce or default.
function asManagementAction(value: string, asset: AssetSymbol): ManagementAction {
  if (!(VALID_MANAGEMENT_ACTIONS as readonly string[]).includes(value)) {
    throw new JevCallError(`Jev returned an unrecognized management action "${value}" for ${asset}`)
  }
  return value as ManagementAction
}
function asStopIntent(value: string, asset: AssetSymbol): StopIntent {
  if (!(VALID_STOP_INTENTS as readonly string[]).includes(value)) {
    throw new JevCallError(`Jev returned an unrecognized stop intent "${value}" for ${asset}`)
  }
  return value as StopIntent
}
function asTargetIntent(value: string, asset: AssetSymbol): TargetIntent {
  if (!(VALID_TARGET_INTENTS as readonly string[]).includes(value)) {
    throw new JevCallError(`Jev returned an unrecognized target intent "${value}" for ${asset}`)
  }
  return value as TargetIntent
}

export interface ManagementOutcome {
  asset: AssetSymbol
  action: ManagementAction
  // Raw confidence + full probability distribution — persisted verbatim
  // (same "containment, not suppression" reasoning as VetoOutcome.noul):
  // nothing in v1 gates on this (migration plan §7's explicit reversal of
  // an earlier, unsafe blanket confidence-threshold draft), but every
  // observation is kept so a future, task-specific gate — if any — can be
  // chosen from real data.
  actionConfidence: number
  actionProbabilities: Record<string, number>
  // Speculative — always populated regardless of what `action` turned out
  // to be (the documented fan-out pattern); cycle/apply-management.ts
  // consumes only the field matching the actual action.
  addMagnitude: number
  reduceMagnitude: number
  stopIntent: StopIntent
  targetIntent: TargetIntent
}

export interface PortfolioRequestResult {
  vetoOutcomes: VetoOutcome[]
  managementOutcomes: ManagementOutcome[]
  modelVersion: string
  rawRequest: unknown
  rawResponse: unknown
}

export async function requestPortfolioDecisions(
  vetoCandidates: VetoCandidateInput[],
  managementCandidates: ManagementCandidateInput[],
  navUsd: number,
  availableCashUsd: number,
  totalExposurePct: number,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  options: JevCallOptions = {},
): Promise<PortfolioRequestResult> {
  if (!apiKey) {
    throw new JevCallError('requestPortfolioDecisions: no TYPESAFE_API_KEY configured')
  }

  const nowIso = new Date().toISOString()
  const state = buildPortfolioState(vetoCandidates, managementCandidates, navUsd, availableCashUsd, totalExposurePct, nowIso)
  const questions = { ...buildJevQuestions(vetoCandidates), ...buildManagementQuestions(managementCandidates) }

  const result = await callJev(JEV_MODEL_ID, state, questions, apiKey, fetchImpl, options)
  const answerById = new Map<string, JevAnswer>(result.answers.map((a) => [a.questionId, a]))
  const mustFind = (id: string): JevAnswer => {
    // Safe by construction, same reasoning as requestVetoDecisions above:
    // callJev's parseJevResponse already asserted exact cardinality
    // against exactly the id set `questions` above was built from.
    const found = answerById.get(id)
    if (!found) throw new JevCallError(`requestPortfolioDecisions: no answer found for question ${id} — should be unreachable given exact-cardinality parsing`)
    return found
  }

  const vetoOutcomes: VetoOutcome[] = vetoCandidates.map((candidate) => {
    const noul = expectNoul(mustFind(vetoQuestionId(candidate.asset)))
    return { asset: candidate.asset, veto: noul >= JEV_VETO_THRESHOLD, noul }
  })

  const managementOutcomes: ManagementOutcome[] = managementCandidates.map((candidate) => {
    const action = expectChoice(mustFind(managementActionQuestionId(candidate.asset)))
    const addConviction = expectScore(mustFind(addConvictionQuestionId(candidate.asset)))
    const reduceMagnitude = expectScore(mustFind(reduceMagnitudeQuestionId(candidate.asset)))
    const stopIntent = expectChoice(mustFind(stopIntentQuestionId(candidate.asset)))
    const targetIntent = expectChoice(mustFind(targetIntentQuestionId(candidate.asset)))

    return {
      asset: candidate.asset,
      action: asManagementAction(action.choice, candidate.asset),
      actionConfidence: action.confidence,
      actionProbabilities: action.probabilities,
      addMagnitude: magnitudeFromScore(addConviction.score, ADD_MAGNITUDE_BY_SCORE_LEVEL),
      reduceMagnitude: magnitudeFromScore(reduceMagnitude.score, REDUCE_MAGNITUDE_BY_SCORE_LEVEL),
      stopIntent: asStopIntent(stopIntent.choice, candidate.asset),
      targetIntent: asTargetIntent(targetIntent.choice, candidate.asset),
    }
  })

  return {
    vetoOutcomes,
    managementOutcomes,
    modelVersion: result.modelVersion,
    rawRequest: { model: JEV_MODEL_ID, state, questions },
    rawResponse: result.rawResponse,
  }
}
