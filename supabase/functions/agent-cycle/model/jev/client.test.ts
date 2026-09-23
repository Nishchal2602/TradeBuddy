import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { callJev, JevCallError } from './client.ts'
import { expectNoul, JevOutputShapeError } from './schema.ts'
import type { JevQuestionSpec, JevState } from './question.ts'

const STATE: JevState = { evaluatedAt: '2026-09-22T09:00:00.000Z', assets: { BTC: { news: [] } } }
const QUESTIONS: Record<string, JevQuestionSpec> = {
  veto_btc: { type: 'noul', instructions: 'test', criteria: { true: 't', false: 'f' } },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const VALID_BODY = { model: 'jev-1.13.0', answers: { veto_btc: { type: 'noul', noul: 0.12 } } }

// Fast options for every test that isn't specifically exercising real
// timing — the production defaults (15s timeout, up to 2 retries with
// exponential backoff) would make this suite unbearably slow otherwise.
const FAST = { timeoutMs: 50, maxRetries: 2, backoffBaseMs: 5 }

Deno.test('callJev: succeeds on the first attempt, exactly one HTTP request', async () => {
  let calls = 0
  const fetchImpl = (() => {
    calls++
    return Promise.resolve(jsonResponse(VALID_BODY))
  }) as unknown as typeof fetch

  const result = await callJev('jev-latest', STATE, QUESTIONS, 'key', fetchImpl, FAST)
  assertEquals(calls, 1)
  assertEquals(result.modelVersion, 'jev-1.13.0')
  assertEquals(expectNoul(result.answers[0]!), 0.12)
})

Deno.test('callJev: a two-question batch is still exactly one HTTP request, not one per question', async () => {
  let calls = 0
  const twoQuestions = { ...QUESTIONS, veto_eth: { type: 'noul' as const, instructions: 'x', criteria: { true: 't', false: 'f' } } }
  const fetchImpl = (() => {
    calls++
    return Promise.resolve(jsonResponse({ model: 'jev-1.13.0', answers: { veto_btc: { type: 'noul', noul: 0.1 }, veto_eth: { type: 'noul', noul: 0.9 } } }))
  }) as unknown as typeof fetch

  const result = await callJev('jev-latest', STATE, twoQuestions, 'key', fetchImpl, FAST)
  assertEquals(calls, 1)
  assertEquals(result.answers.length, 2)
})

Deno.test('callJev: sends the Bearer authorization header and the model/state/questions body', async () => {
  let seenInit: RequestInit | undefined
  const fetchImpl = ((_url: string, init?: RequestInit) => {
    seenInit = init
    return Promise.resolve(jsonResponse(VALID_BODY))
  }) as unknown as typeof fetch

  await callJev('jev-latest', STATE, QUESTIONS, 'my-key', fetchImpl, FAST)
  const headers = seenInit!.headers as Record<string, string>
  assertEquals(headers.authorization, 'Bearer my-key')
  const body = JSON.parse(seenInit!.body as string)
  assertEquals(body.model, 'jev-latest')
  assertEquals(body.state, STATE)
  assertEquals(body.questions, QUESTIONS)
})

Deno.test('callJev: 401 fails immediately, no retry', async () => {
  let calls = 0
  const fetchImpl = (() => {
    calls++
    return Promise.resolve(jsonResponse({ detail: 'invalid API key' }, 401))
  }) as unknown as typeof fetch

  await assertRejects(() => callJev('jev-latest', STATE, QUESTIONS, 'bad-key', fetchImpl, FAST), JevCallError)
  assertEquals(calls, 1, 'a 401 must not burn a retry — a bad key will not fix itself')
})

Deno.test('callJev: 422 fails immediately, no retry, and never echoes the raw error body', async () => {
  let calls = 0
  const fetchImpl = (() => {
    calls++
    return Promise.resolve(jsonResponse({ detail: [{ loc: ['body', 'state'], msg: 'field required', type: 'missing', input: 'SENSITIVE NEWS HEADLINE TEXT' }] }, 422))
  }) as unknown as typeof fetch

  const err = await assertRejects(() => callJev('jev-latest', STATE, QUESTIONS, 'key', fetchImpl, FAST), JevCallError)
  assertEquals(calls, 1, 'a 422 must not burn a retry — our own request is malformed and retrying sends the identical bad request')
  assertEquals((err as JevCallError).message.includes('SENSITIVE NEWS HEADLINE TEXT'), false)
})

Deno.test('callJev: 429 retries and succeeds on a later attempt', async () => {
  let calls = 0
  const fetchImpl = (() => {
    calls++
    if (calls === 1) return Promise.resolve(jsonResponse({ detail: 'rate limited' }, 429))
    return Promise.resolve(jsonResponse(VALID_BODY))
  }) as unknown as typeof fetch

  const result = await callJev('jev-latest', STATE, QUESTIONS, 'key', fetchImpl, FAST)
  assertEquals(calls, 2)
  assertEquals(result.modelVersion, 'jev-1.13.0')
})

Deno.test('callJev: 529 (overloaded) retries and succeeds on a later attempt', async () => {
  let calls = 0
  const fetchImpl = (() => {
    calls++
    if (calls === 1) return Promise.resolve(jsonResponse({ detail: 'overloaded' }, 529))
    return Promise.resolve(jsonResponse(VALID_BODY))
  }) as unknown as typeof fetch

  const result = await callJev('jev-latest', STATE, QUESTIONS, 'key', fetchImpl, FAST)
  assertEquals(calls, 2)
  assertEquals(result.modelVersion, 'jev-1.13.0')
})

Deno.test('callJev: 5xx retries and succeeds on a later attempt', async () => {
  let calls = 0
  const fetchImpl = (() => {
    calls++
    if (calls === 1) return Promise.resolve(jsonResponse({ detail: 'internal error' }, 503))
    return Promise.resolve(jsonResponse(VALID_BODY))
  }) as unknown as typeof fetch

  const result = await callJev('jev-latest', STATE, QUESTIONS, 'key', fetchImpl, FAST)
  assertEquals(calls, 2)
  assertEquals(result.modelVersion, 'jev-1.13.0')
})

Deno.test('callJev: retries are bounded — exhausting maxRetries on a persistent 429 still fails', async () => {
  let calls = 0
  const fetchImpl = (() => {
    calls++
    return Promise.resolve(jsonResponse({ detail: 'rate limited' }, 429))
  }) as unknown as typeof fetch

  await assertRejects(() => callJev('jev-latest', STATE, QUESTIONS, 'key', fetchImpl, { ...FAST, maxRetries: 2 }), JevCallError)
  assertEquals(calls, 3, 'maxRetries=2 means 3 total attempts (1 initial + 2 retries), never more')
})

Deno.test('callJev: a genuine timeout (AbortController fires) is retried, then fails after exhausting retries', async () => {
  // Simulates a hung connection: never resolves on its own, only rejects
  // once the signal this module itself attaches actually aborts — proves
  // the real AbortController wiring works, not just a mocked rejection.
  let attempts = 0
  const fetchImpl = ((_url: string, init?: RequestInit) => {
    attempts++
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted', 'AbortError'))
      })
      // Otherwise never resolves — a genuinely hung request.
    })
  }) as unknown as typeof fetch

  const err = await assertRejects(
    () => callJev('jev-latest', STATE, QUESTIONS, 'key', fetchImpl, { timeoutMs: 20, maxRetries: 1, backoffBaseMs: 5 }),
    JevCallError,
  )
  assertEquals(attempts, 2, 'timeout is retryable, same as a network error — 1 initial + 1 retry')
  assertEquals((err as JevCallError).message.toLowerCase().includes('timeout') || (err as JevCallError).message.toLowerCase().includes('abort'), true)
})

Deno.test('callJev: a plain network error (fetch rejects) is retried, same as a timeout', async () => {
  let calls = 0
  const fetchImpl = (() => {
    calls++
    return Promise.reject(new TypeError('network unreachable'))
  }) as unknown as typeof fetch

  await assertRejects(() => callJev('jev-latest', STATE, QUESTIONS, 'key', fetchImpl, FAST), JevCallError)
  assertEquals(calls, 3, '1 initial + 2 retries under FAST options')
})

Deno.test('callJev: a shape failure (malformed/unexpected response body) fails immediately, no retry', async () => {
  let calls = 0
  const fetchImpl = (() => {
    calls++
    return Promise.resolve(jsonResponse({ model: 'jev-1.13.0', answers: { veto_eth: { type: 'noul', noul: 0.5 } } })) // wrong question id
  }) as unknown as typeof fetch

  await assertRejects(() => callJev('jev-latest', STATE, QUESTIONS, 'key', fetchImpl, FAST), JevOutputShapeError)
  assertEquals(calls, 1, 'a content-level shape mismatch would recur identically on retry — must not burn the retry budget')
})

Deno.test('callJev: non-JSON body on an otherwise-200 response is treated as a shape failure', async () => {
  let calls = 0
  const fetchImpl = (() => {
    calls++
    return Promise.resolve(new Response('not json{{{', { status: 200 }))
  }) as unknown as typeof fetch

  await assertRejects(() => callJev('jev-latest', STATE, QUESTIONS, 'key', fetchImpl, FAST), JevOutputShapeError)
  assertEquals(calls, 1)
})
