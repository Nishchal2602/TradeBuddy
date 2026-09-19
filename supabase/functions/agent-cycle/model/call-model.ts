import type { ModelDecisionProposal } from '../../../../src/shared/decisions/types.ts'
import { GEMINI_RESPONSE_SCHEMA, parseModelOutput } from './gemini-schema.ts'
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserContent } from './prompt.ts'
import type { ModelCallPayload } from './payload.ts'

// The one callModel(payload) abstraction every model call goes through
// (CLAUDE.md § AI-specific rules) — Gemini today, swappable to a
// different provider or a single paid-tier key later behind this same
// signature (progress-tracker.md Architecture Decisions), not a code
// change at every call site.

const MODEL_ID = 'gemini-2.5-flash'
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

// maxOutputTokens covers thinking tokens AND the visible output combined
// (confirmed live, 2026-09-19 — gemini-2.5-flash spent 100+ thinking
// tokens on even a one-line trivial prompt). Sized well above the
// superseded spec's original 4096 figure, which predates that finding and
// would risk a silent MAX_TOKENS truncation on a real, much longer
// prompt. Thinking is left at its default (not forced to a budget of 0)
// deliberately — that's a reasoning-quality lever adjacent to the
// NEWS/TECHNICAL methodology the user explicitly deferred, not a plumbing
// concern this step should decide.
const GENERATION_CONFIG = {
  temperature: 0.2,
  maxOutputTokens: 8192,
}

export class ModelCallError extends Error {
  override readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'ModelCallError'
    this.cause = cause
  }
}

export interface CallModelResult {
  decisions: ModelDecisionProposal[]
  // Exact raw JSON returned by the model, for agent_decisions.output_payload
  // (invariant 8 — replayability).
  rawOutputPayload: unknown
  modelVersion: string
  promptVersion: string
  // 0-based index into the apiKeys array that succeeded — diagnostic only,
  // e.g. to notice one key is being rate-limited far more than the others.
  keyIndexUsed: number
}

interface KeyFailure {
  keyIndex: number
  reason: string
}

// Tries each key in order; an HTTP/network failure moves to the next key
// (key-specific problems: quota, revoked key, transient network blip). A
// content-level problem (non-STOP finish reason, unparseable/invalid
// JSON) is NOT retried against another key and fails the call immediately
// instead — the same prompt against the same model would hit the same
// problem regardless of which key sent it, so rotating keys for it would
// just burn quota on all three for no chance of a different outcome.
export async function callModel(
  payload: ModelCallPayload,
  apiKeys: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<CallModelResult> {
  if (apiKeys.length === 0) {
    throw new ModelCallError('callModel: no API keys configured')
  }

  const expectedAssets = payload.assets.map((a) => a.asset)
  const failures: KeyFailure[] = []

  for (let i = 0; i < apiKeys.length; i++) {
    const key = apiKeys[i]!
    let response: Response
    try {
      response = await fetchImpl(`${BASE_URL}/models/${MODEL_ID}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: buildUserContent(payload) }] }],
          generationConfig: {
            ...GENERATION_CONFIG,
            responseMimeType: 'application/json',
            responseSchema: GEMINI_RESPONSE_SCHEMA,
          },
        }),
      })
    } catch (cause) {
      failures.push({ keyIndex: i, reason: `network error: ${cause instanceof Error ? cause.message : String(cause)}` })
      continue
    }

    if (!response.ok) {
      let detail = `HTTP ${response.status}`
      try {
        const errBody: unknown = await response.json()
        const message = (errBody as { error?: { message?: string } })?.error?.message
        detail += `: ${message ?? JSON.stringify(errBody).slice(0, 200)}`
      } catch {
        // Non-JSON error body — the status code alone is still logged.
      }
      failures.push({ keyIndex: i, reason: detail })
      continue
    }

    const body = await response.json()
    const candidate = body?.candidates?.[0]
    const finishReason = candidate?.finishReason
    if (finishReason !== 'STOP') {
      throw new ModelCallError(`model call finished with reason ${finishReason ?? 'unknown'} (key ${i + 1}/${apiKeys.length})`, body)
    }

    const text = candidate?.content?.parts?.[0]?.text
    if (typeof text !== 'string') {
      throw new ModelCallError(`model response had no text content (key ${i + 1}/${apiKeys.length})`, body)
    }

    let rawJson: unknown
    try {
      rawJson = JSON.parse(text)
    } catch (cause) {
      throw new ModelCallError(`model response text was not valid JSON (key ${i + 1}/${apiKeys.length})`, cause)
    }

    // Throws ModelOutputShapeError on any shape mismatch — deliberately
    // not caught here. A malformed response is a content problem, same
    // category as a bad finishReason above: it propagates as this call's
    // failure rather than being wrapped or retried against another key.
    const decisions = parseModelOutput(rawJson, expectedAssets)

    return {
      decisions,
      rawOutputPayload: rawJson,
      modelVersion: typeof body.modelVersion === 'string' ? body.modelVersion : MODEL_ID,
      promptVersion: PROMPT_VERSION,
      keyIndexUsed: i,
    }
  }

  throw new ModelCallError(
    `all ${apiKeys.length} API key(s) failed: ${failures.map((f) => `key ${f.keyIndex + 1}: ${f.reason}`).join('; ')}`,
  )
}
