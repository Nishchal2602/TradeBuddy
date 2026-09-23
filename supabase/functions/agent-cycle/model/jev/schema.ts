import { z } from 'zod'

// Validates TypeSafe's SystemOneResponse envelope — confirmed against the
// official OpenAPI schema (https://api.typesafe.ai/openapi.json) and
// docs.typesafe.ai/primitives/{noul,choice,score}.md, 2026-09-22, not from
// memory or a third-party summary. `answers` is a map keyed by question
// id, not an array — mirrors the request's own `questions` map shape.
//
// Choice/Score answers added by Phase 2 (2026-09-22, "Jev as a portfolio-
// management decision layer") — the API contract confirms a single
// request's `questions` map can mix all three types freely, and Phase 2's
// design deliberately puts a FLAT asset's veto (noul) question and an
// OPEN asset's management (choice/score) questions in the SAME shared
// request when both exist in one cycle, so the response envelope must be
// able to carry a genuine mix, not just repeated noul answers.
//
// NoulAnswer exposes only `noul` (0-1) — no `confidence` field, as read
// from the schema at the time this was written. Choice/Score DO carry
// `confidence` plus a full `probabilities` distribution — this module
// parses and uses only fields actually present in the schema for each
// type; it does not assume a confidence field on Noul, and does not
// invent fields on Choice/Score beyond what the docs confirm.

const NoulAnswerSchema = z.object({
  type: z.literal('noul'),
  noul: z.number().min(0).max(1),
})

const ChoiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string().min(1),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number()),
})

const ScoreAnswerSchema = z.object({
  type: z.literal('score'),
  score: z.number(),
  confidence: z.number().min(0).max(1),
  legend: z.record(z.string(), z.string()),
  probabilities: z.record(z.string(), z.number()),
})

const AnswerSchema = z.discriminatedUnion('type', [NoulAnswerSchema, ChoiceAnswerSchema, ScoreAnswerSchema])

const SystemOneResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), AnswerSchema),
  // Optional: present on real responses per the docs, but this parser
  // must not hard-fail on its absence — usage accounting is not a
  // decision input.
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
  }).optional(),
})

export class JevOutputShapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JevOutputShapeError'
  }
}

// A flat discriminated union, not one object with every field optional —
// same reasoning as ModelDecisionProposal (src/shared/decisions/types.ts):
// a caller must narrow on `type` before reading a type-specific field
// (`.noul`, `.choice`, `.score`), which the type system enforces rather
// than trusting every caller to check by convention. This is a genuine,
// deliberate change from the pre-Phase-2 shape (which assumed every
// answer was noul and exposed `.noul` unconditionally) — a caller reading
// `.noul` off an answer the API actually returned as `choice`/`score`
// would previously have silently read `undefined`, not failed loudly.
export type JevAnswer =
  | { questionId: string; type: 'noul'; noul: number }
  | { questionId: string; type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { questionId: string; type: 'score'; score: number; confidence: number; legend: Record<string, string>; probabilities: Record<string, number> }

export interface ParsedJevResponse {
  modelVersion: string
  answers: JevAnswer[]
}

// Entry point: raw Jev JSON (already JSON.parse'd) -> validated
// per-question answers, asserting exactly one answer per requested
// question id — a response missing a question, repeating one, or
// answering an unrequested one is a shape failure, never silently
// tolerated. Same "loose wire shape -> strict domain parse, exact
// cardinality checked" discipline the Gemini-era parseVetoOutput used.
export function parseJevResponse(rawJson: unknown, expectedQuestionIds: readonly string[]): ParsedJevResponse {
  const parsed = SystemOneResponseSchema.safeParse(rawJson)
  if (!parsed.success) {
    throw new JevOutputShapeError(`Jev response did not match the expected schema: ${parsed.error.message}`)
  }

  const gotIds = Object.keys(parsed.data.answers).sort()
  const wantIds = [...expectedQuestionIds].sort()
  if (JSON.stringify(gotIds) !== JSON.stringify(wantIds)) {
    throw new JevOutputShapeError(`expected exactly one answer per question ${JSON.stringify(wantIds)}, got ${JSON.stringify(gotIds)}`)
  }

  const answers: JevAnswer[] = expectedQuestionIds.map((id) => ({ questionId: id, ...parsed.data.answers[id]! }))
  return { modelVersion: parsed.data.model, answers }
}

// Typed narrowing helpers — a caller asks for the type it expects (it
// knows this from which question it built, e.g. a veto question is
// always 'noul'); a mismatch is a genuine shape failure (the API
// returned a different answer type than the question it was asked),
// never silently coerced or defaulted.
export function expectNoul(answer: JevAnswer): number {
  if (answer.type !== 'noul') throw new JevOutputShapeError(`expected a noul answer for question ${answer.questionId}, got ${answer.type}`)
  return answer.noul
}

export function expectChoice(answer: JevAnswer): { choice: string; confidence: number; probabilities: Record<string, number> } {
  if (answer.type !== 'choice') throw new JevOutputShapeError(`expected a choice answer for question ${answer.questionId}, got ${answer.type}`)
  return answer
}

export function expectScore(answer: JevAnswer): { score: number; confidence: number; legend: Record<string, string>; probabilities: Record<string, number> } {
  if (answer.type !== 'score') throw new JevOutputShapeError(`expected a score answer for question ${answer.questionId}, got ${answer.type}`)
  return answer
}
