import { parseJevResponse } from './schema.ts'
import type { JevAnswer } from './schema.ts'
import type { JevQuestionSpec, JevState } from './question.ts'
import type { JevManagementQuestionSpec } from './management-question.ts'

// Phase 2 (2026-09-22): one request's `questions` map can hold a mix of
// the veto's noul questions and the management layer's choice/score
// questions (the API contract confirms mixed types in one request) — the
// transport layer itself needs no other change to support this.
type AnyJevQuestionSpec = JevQuestionSpec | JevManagementQuestionSpec

// The transport layer: request construction, auth, timeout, and bounded
// retry/backoff. No fallback provider exists (Gemini removed entirely,
// 2026-09-22) — every failure this module cannot recover from propagates
// as JevCallError, and the caller (provider.ts -> index.ts) fails the
// candidate closed to HOLD. See the migration plan's "Exact failure
// behavior" table for the full retry/no-retry matrix this implements.

const BASE_URL = 'https://api.typesafe.ai/v1'

// A hung request must not block a cycle indefinitely — the pre-migration
// Gemini adapter had NO timeout at all (a real, live gap this migration
// closes, not a hypothetical one). 15s per attempt, at most 2 retries
// with exponential backoff, keeps the worst case (~1 minute) well inside
// the 10-minute stale-run reaper window added earlier this session
// (cycle/idempotency.ts) — a hung Jev call must never be what triggers
// that reaper.
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_BACKOFF_BASE_MS = 500

export class JevCallError extends Error {
  override readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'JevCallError'
    this.cause = cause
  }
}

export interface JevCallOptions {
  timeoutMs?: number
  maxRetries?: number
  backoffBaseMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Retryable: network errors/timeouts, 429 (rate limit), 529 (overloaded),
// and general 5xx — all plausibly transient, and TypeSafe's own docs
// prescribe backoff for 429/529 specifically. Non-retryable: 401/403 (a
// bad key will not fix itself on retry) and 422 (our own request is
// malformed — retrying sends the identical bad request again, just burns
// the retry budget for zero chance of a different outcome). This mirrors
// the Gemini adapter's own "content-level failure doesn't rotate" logic,
// just against a different failure taxonomy.
function isRetryableStatus(status: number): boolean {
  if (status === 429 || status === 529) return true
  if (status >= 500 && status < 600) return true
  return false
}

interface RawAttemptResult {
  status: number
  body: unknown
}

async function attemptOnce(
  model: string,
  state: JevState,
  questions: Record<string, AnyJevQuestionSpec>,
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<RawAttemptResult> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${BASE_URL}/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, state, questions }),
      signal: controller.signal,
    })
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      // Non-JSON error body — the status code alone is still known and
      // used below.
    }
    return { status: response.status, body }
  } finally {
    clearTimeout(timeoutId)
  }
}

// detail[].input (the 422 HTTPValidationError shape) may echo back the
// offending request value — that can include news headline/summary text
// or other request content. Never log or surface it verbatim; a bounded,
// generic description is all that's ever exposed.
function describeErrorBody(status: number, body: unknown): string {
  if (status === 422) return `validation error (HTTP 422) — request rejected by Jev`
  if (body && typeof body === 'object' && 'detail' in (body as Record<string, unknown>)) {
    const detail = (body as Record<string, unknown>).detail
    if (typeof detail === 'string') return `HTTP ${status}: ${detail.slice(0, 200)}`
  }
  return `HTTP ${status}`
}

export async function callJev(
  model: string,
  state: JevState,
  questions: Record<string, AnyJevQuestionSpec>,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  options: JevCallOptions = {},
): Promise<{ modelVersion: string; answers: JevAnswer[]; rawResponse: unknown }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS
  const expectedQuestionIds = Object.keys(questions)

  let lastFailureDetail = 'unknown failure'

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let result: RawAttemptResult
    try {
      result = await attemptOnce(model, state, questions, apiKey, fetchImpl, timeoutMs)
    } catch (cause) {
      // AbortError (our own timeout firing) or a genuine network throw —
      // both retryable, same as a 5xx.
      lastFailureDetail = `network error or timeout: ${cause instanceof Error ? cause.message : String(cause)}`
      if (attempt < maxRetries) {
        await sleep(backoffBaseMs * 2 ** attempt)
        continue
      }
      throw new JevCallError(`Jev call failed after ${attempt + 1} attempt(s): ${lastFailureDetail}`, cause)
    }

    if (result.status >= 200 && result.status < 300) {
      // Throws JevOutputShapeError on any shape mismatch — deliberately
      // not caught here. A malformed response is a content problem, not
      // a transport one: it propagates as this call's failure rather
      // than being retried, matching the non-retryable 422 reasoning
      // above (the same request would produce the same malformed
      // response again).
      const parsed = parseJevResponse(result.body, expectedQuestionIds)
      return { modelVersion: parsed.modelVersion, answers: parsed.answers, rawResponse: result.body }
    }

    lastFailureDetail = describeErrorBody(result.status, result.body)

    if (!isRetryableStatus(result.status) || attempt === maxRetries) {
      throw new JevCallError(`Jev call failed: ${lastFailureDetail}`)
    }
    await sleep(backoffBaseMs * 2 ** attempt)
  }

  // Unreachable in practice (the loop always returns or throws above),
  // kept only to satisfy the compiler's control-flow analysis.
  throw new JevCallError(`Jev call failed: ${lastFailureDetail}`)
}
